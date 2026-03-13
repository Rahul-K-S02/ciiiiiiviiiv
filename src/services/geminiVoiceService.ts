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
  onProofRequested: () => void;
  onIncidentTypeDetected: (type: IncidentType) => void;
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

  private pendingProofCallId: string | null = null;

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
          Your goal is to help residents report infrastructure issues and handle emergencies.
          
          CLASSIFICATION:
          - Emergency: 'fire', 'medical_emergency', 'police_emergency'.
          - Non-Emergency: 'road_damage', 'electrical', 'water_supply', 'sanitation', 'other'.
          
          GUIDELINES:
          1. Be professional, empathetic, and efficient.
          2. FOR NON-EMERGENCY CASES: You MUST ask the user for photographic proof (an image) before registering the complaint. You MUST call the 'requestProof' tool to trigger the upload UI for the user. 
          3. The 'requestProof' tool will only return a response AFTER the user has successfully attached a photo. Wait for this tool to complete before calling 'reportIncident'.
          4. FOR EMERGENCY CASES: Process the report IMMEDIATELY. Do NOT ask for proof.
          5. FOR EMERGENCY CASES: You MUST provide immediate first aid or safety instructions:
             - Fire: "Evacuate immediately, stay low to the ground to avoid smoke, and do not use elevators."
             - Medical: "Keep the person still, check for breathing, and apply pressure to any bleeding wounds."
             - Police: "Stay in a safe location and avoid confrontation."
          6. FOR EMERGENCY CASES: You MUST provide emergency contact numbers:
             - Police: 100
             - Fire Station: 101
             - Ambulance: 102
          7. Use the 'reportIncident' tool to create a ticket once requirements are met.
          8. The user's current location is: ${userLocation.address} (Lat: ${userLocation.lat}, Lng: ${userLocation.lng}).
          9. Support barge-in: if the user interrupts, stop and listen.
          10. Use 'identifyIncident' as soon as you are reasonably sure of the category, especially for emergencies.`,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "identifyIncident",
                  description: "Informs the system of the detected incident type early in the conversation.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      type: { 
                        type: Type.STRING, 
                        enum: ["road_damage", "electrical", "water_supply", "sanitation", "fire", "medical_emergency", "police_emergency", "other"],
                        description: "The category of the issue."
                      }
                    },
                    required: ["type"]
                  }
                },
                {
                  name: "requestProof",
                  description: "Triggers the photo upload UI. This tool will wait and only return once the user has attached a photo.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "reportIncident",
                  description: "Reports a new urban incident or emergency to the city management system.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      type: { 
                        type: Type.STRING, 
                        enum: ["road_damage", "electrical", "water_supply", "sanitation", "fire", "medical_emergency", "police_emergency", "other"],
                        description: "The category of the issue."
                      },
                      description: { type: Type.STRING, description: "Detailed description of the problem." },
                      priority: { 
                        type: Type.STRING, 
                        enum: ["low", "medium", "high", "critical"],
                        description: "Urgency of the issue."
                      },
                      hasProof: {
                        type: Type.BOOLEAN,
                        description: "Whether the user has provided photographic proof (required for non-emergencies)."
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

            // Handle Tool Calls
            if (message.toolCall) {
              for (const call of message.toolCall.functionCalls) {
                if (call.name === "identifyIncident") {
                  const args = call.args as { type: IncidentType };
                  callbacks.onIncidentTypeDetected(args.type);
                  const session = await sessionPromise;
                  session.sendToolResponse({
                    functionResponses: [{
                      name: "identifyIncident",
                      id: call.id,
                      response: { result: "Acknowledged. UI updated with incident-specific information." }
                    }]
                  });
                } else if (call.name === "requestProof") {
                  this.pendingProofCallId = call.id;
                  callbacks.onProofRequested();
                  // We do NOT send the tool response yet. 
                  // It will be sent when confirmProof() is called.
                } else if (call.name === "reportIncident") {
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

  async confirmProof() {
    if (this.session && this.pendingProofCallId) {
      await this.session.sendToolResponse({
        functionResponses: [{
          name: "requestProof",
          id: this.pendingProofCallId,
          response: { result: "Success: User has attached photographic proof." }
        }]
      });
      this.pendingProofCallId = null;
      return true;
    }
    return false;
  }

  private async handleReportIncident(args: { type: IncidentType, description: string, priority: IncidentPriority, hasProof?: boolean }, location: any) {
    if (!auth.currentUser) return "Error: User not authenticated";

    const isEmergency = ['fire', 'medical_emergency', 'police_emergency'].includes(args.type);
    
    if (!isEmergency && !args.hasProof) {
      return "Error: Photographic proof is required for non-emergency reports. Please provide an image first.";
    }

    try {
      const incidentData = {
        type: args.type,
        description: args.description,
        priority: isEmergency ? 'critical' : args.priority,
        status: "reported",
        location: {
          latitude: location.lat,
          longitude: location.lng,
          address: location.address
        },
        reporterUid: auth.currentUser.uid,
        reporterName: auth.currentUser.displayName || "Anonymous",
        createdAt: new Date().toISOString(),
        eta: isEmergency ? "Immediate Response Dispatched" : this.calculateETA(args.type, args.priority),
        hasProof: !!args.hasProof
      };

      const docRef = await addDoc(collection(db, "incidents"), incidentData);
      
      let response = `Success: Incident reported with ID ${docRef.id}.`;
      if (isEmergency) {
        response += " EMERGENCY SERVICES HAVE BEEN DISPATCHED IMMEDIATELY.";
      } else {
        response += ` ETA for resolution is ${incidentData.eta}.`;
      }
      return response;
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
    if (['fire', 'medical_emergency', 'police_emergency'].includes(type)) return "Immediate Response Dispatched";
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
