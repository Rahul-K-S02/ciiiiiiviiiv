import { GoogleGenAI, Modality, LiveServerMessage, Type } from "@google/genai";
import { Incident, IncidentType, IncidentPriority } from "../types";
import { db, auth } from "../firebase";
import { collection, addDoc, query, where, getDocs, serverTimestamp } from "firebase/firestore";

const MODEL = "gemini-2.5-flash-native-audio-preview-09-2025";

export interface VoiceAgentCallbacks {
  onAudioOutput: (base64Audio: string) => void;
  onTranscript: (text: string, isUser: boolean) => void;
  onInterrupted: () => void;
  onError: (error: string) => void;
  onStatusChange: (status: string) => void;
}

export class GeminiVoiceService {
  private ai: GoogleGenAI;
  private session: any = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async connect(callbacks: VoiceAgentCallbacks, userLocation: { lat: number, lng: number, address: string }) {
    try {
      const sessionPromise = this.ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: `You are CivicVoice AI, an autonomous smart city assistant. 
          Your goal is to help residents report infrastructure issues like road damage, water leaks, or electrical problems.
          
          Guidelines:
          1. Be professional, empathetic, and efficient.
          2. Use the 'reportIncident' tool to create a ticket once you have enough details (type, description).
          3. Use the 'checkExistingIncidents' tool if the user mentions a common problem to see if it's already reported.
          4. The user's current location is: ${userLocation.address} (Lat: ${userLocation.lat}, Lng: ${userLocation.lng}).
          5. If an issue is reported, confirm the ticket creation and provide a simulated ETA.
          6. Support barge-in: if the user interrupts, stop and listen.
          7. If you need more info, ask clearly.`,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "reportIncident",
                  description: "Reports a new urban incident to the city management system.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      type: { 
                        type: Type.STRING, 
                        enum: ["road_damage", "electrical", "water_supply", "sanitation", "other"],
                        description: "The category of the issue."
                      },
                      description: { type: Type.STRING, description: "Detailed description of the problem." },
                      priority: { 
                        type: Type.STRING, 
                        enum: ["low", "medium", "high", "critical"],
                        description: "Urgency of the issue."
                      }
                    },
                    required: ["type", "description", "priority"]
                  }
                },
                {
                  name: "checkExistingIncidents",
                  description: "Checks if a similar issue has already been reported nearby.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      type: { type: Type.STRING, description: "Category to check." }
                    },
                    required: ["type"]
                  }
                }
              ]
            }
          ]
        },
        callbacks: {
          onopen: () => {
            callbacks.onStatusChange("Connected");
            this.startMicStreaming(sessionPromise);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData) {
                  callbacks.onAudioOutput(part.inlineData.data);
                }
                if (part.text) {
                  callbacks.onTranscript(part.text, false);
                }
              }
            }

            if (message.serverContent?.interrupted) {
              callbacks.onInterrupted();
            }

            if (message.serverContent?.turnComplete) {
              // Turn finished
            }

            // Handle Tool Calls
            if (message.toolCall) {
              for (const call of message.toolCall.functionCalls) {
                if (call.name === "reportIncident") {
                  const result = await this.handleReportIncident(call.args as any, userLocation);
                  const session = await sessionPromise;
                  session.sendToolResponse({
                    functionResponses: [{
                      name: "reportIncident",
                      id: call.id,
                      response: { result }
                    }]
                  });
                } else if (call.name === "checkExistingIncidents") {
                  const result = await this.handleCheckExisting(call.args as any);
                  const session = await sessionPromise;
                  session.sendToolResponse({
                    functionResponses: [{
                      name: "checkExistingIncidents",
                      id: call.id,
                      response: { result }
                    }]
                  });
                }
              }
            }
          },
          onclose: () => {
            callbacks.onStatusChange("Disconnected");
            this.stop();
          },
          onerror: (err) => {
            callbacks.onError(err.message);
          }
        }
      });

      this.session = await sessionPromise;
    } catch (error: any) {
      callbacks.onError(error.message);
    }
  }

  private async handleReportIncident(args: { type: IncidentType, description: string, priority: IncidentPriority }, location: any) {
    if (!auth.currentUser) return "Error: User not authenticated";

    try {
      const incidentData = {
        type: args.type,
        description: args.description,
        priority: args.priority,
        status: "reported",
        location: {
          latitude: location.lat,
          longitude: location.lng,
          address: location.address
        },
        reporterUid: auth.currentUser.uid,
        reporterName: auth.currentUser.displayName || "Anonymous",
        createdAt: new Date().toISOString(),
        eta: this.calculateETA(args.type, args.priority)
      };

      const docRef = await addDoc(collection(db, "incidents"), incidentData);
      return `Success: Incident reported with ID ${docRef.id}. ETA for resolution is ${incidentData.eta}.`;
    } catch (error: any) {
      return `Error: Failed to report incident. ${error.message}`;
    }
  }

  private async handleCheckExisting(args: { type: string }) {
    try {
      const q = query(collection(db, "incidents"), where("type", "==", args.type), where("status", "!=", "resolved"));
      const snapshot = await getDocs(q);
      if (snapshot.empty) return "No existing reports found for this issue type nearby.";
      return `Found ${snapshot.size} existing reports for ${args.type}. We are already working on it!`;
    } catch (error: any) {
      return `Error checking existing reports: ${error.message}`;
    }
  }

  private calculateETA(type: string, priority: string) {
    if (priority === 'critical') return "2-4 hours";
    if (priority === 'high') return "12-24 hours";
    if (type === 'water_supply') return "6 hours";
    if (type === 'electrical') return "4 hours";
    return "2-3 days";
  }

  private async startMicStreaming(sessionPromise: Promise<any>) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = async (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = this.floatTo16BitPCM(inputData);
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
        
        const session = await sessionPromise;
        session.sendRealtimeInput({
          media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
        });
      };

      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
    } catch (error) {
      console.error("Mic streaming error:", error);
    }
  }

  private floatTo16BitPCM(input: Float32Array) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output;
  }

  stop() {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
  }
}
