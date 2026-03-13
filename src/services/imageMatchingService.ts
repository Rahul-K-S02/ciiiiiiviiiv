import { GoogleGenAI, Type } from "@google/genai";
import { Incident } from "../types";

const MODEL = "gemini-3-flash-preview";

export class ImageMatchingService {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async matchImageToIncidents(base64Image: string, existingIncidents: Incident[]): Promise<{ isMatch: boolean; matchedIncidentId?: string; reason: string }> {
    if (existingIncidents.length === 0) {
      return { isMatch: false, reason: "No existing incidents to match against." };
    }

    const incidentContext = existingIncidents.map(inc => ({
      id: inc.id,
      type: inc.type,
      description: inc.description,
      location: inc.location.address
    }));

    const prompt = `
      You are an urban incident matching assistant. 
      I will provide you with an image of a city infrastructure issue and a list of existing reports.
      Your task is to determine if the issue in the image is already covered by one of the existing reports.
      
      Existing Reports:
      ${JSON.stringify(incidentContext, null, 2)}
      
      Analyze the image and compare it with the descriptions and types of the existing reports.
      Return your finding in JSON format.
    `;

    try {
      const response = await this.ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Image.split(',')[1] || base64Image
                }
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isMatch: { type: Type.BOOLEAN },
              matchedIncidentId: { type: Type.STRING, description: "The ID of the matching incident if found." },
              reason: { type: Type.STRING, description: "Explanation of why it matches or doesn't match." }
            },
            required: ["isMatch", "reason"]
          }
        }
      });

      const result = JSON.parse(response.text || "{}");
      return {
        isMatch: !!result.isMatch,
        matchedIncidentId: result.matchedIncidentId,
        reason: result.reason || "Analysis complete."
      };
    } catch (error: any) {
      console.error("Image matching error:", error);
      return { isMatch: false, reason: "Failed to analyze image for matching." };
    }
  }
}
