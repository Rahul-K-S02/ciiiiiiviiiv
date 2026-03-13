export type IncidentType = 'road_damage' | 'electrical' | 'water_supply' | 'sanitation' | 'other';
export type IncidentStatus = 'reported' | 'verified' | 'in_progress' | 'resolved';
export type IncidentPriority = 'low' | 'medium' | 'high' | 'critical';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  trustScore?: number;
  createdAt: string;
  role?: 'admin' | 'user';
}

export interface Incident {
  id: string;
  type: IncidentType;
  description: string;
  location: {
    latitude: number;
    longitude: number;
    address: string;
  };
  status: IncidentStatus;
  priority: IncidentPriority;
  reporterUid: string;
  reporterName: string;
  createdAt: string;
  eta?: string;
  imageUrl?: string;
}

export interface VoiceSessionState {
  isConnected: boolean;
  isRecording: boolean;
  isProcessing: boolean;
  transcript: string;
  aiResponse: string;
  error: string | null;
}
