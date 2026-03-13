/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Phone, 
  PhoneOff, 
  Mic, 
  MicOff, 
  MapPin, 
  AlertTriangle, 
  CheckCircle, 
  Clock, 
  User, 
  LogOut, 
  Shield, 
  Activity,
  ChevronRight,
  Info,
  Layers,
  Search
} from 'lucide-react';
import { 
  auth, 
  db, 
  signInWithPopup, 
  googleProvider, 
  signOut, 
  onAuthStateChanged,
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  setDoc
} from './firebase';
import { UserProfile, Incident, IncidentType, IncidentPriority } from './types';
import { GeminiVoiceService } from './services/geminiVoiceService';
import { ImageMatchingService } from './services/imageMatchingService';
import { AudioPlayer } from './utils/audioPlayer';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Error Boundary Component
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-brand-bg p-4">
          <div className="max-w-md w-full glass-morphism p-8 rounded-2xl text-center">
            <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold mb-2">System Error</h1>
            <p className="text-gray-400 mb-6">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            <button 
              onClick={() => window.location.reload()}
              className="px-6 py-2 bg-brand-primary text-black font-bold rounded-full hover:opacity-90 transition-opacity"
            >
              Restart System
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isCalling, setIsCalling] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [location, setLocation] = useState<{ lat: number, lng: number, address: string } | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [transcripts, setTranscripts] = useState<{ text: string, isUser: boolean }[]>([]);
  const [currentView, setCurrentView] = useState<'home' | 'report' | 'map' | 'dashboard'>('home');
  
  const [hasProof, setHasProof] = useState(false);
  const [isProofModalOpen, setIsProofModalOpen] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  const [matchResult, setMatchResult] = useState<{ isMatch: boolean; reason: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [detectedIncidentType, setDetectedIncidentType] = useState<IncidentType | null>(null);
  
  const voiceService = useRef<GeminiVoiceService | null>(null);
  const matchingService = useRef<ImageMatchingService | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioPlayer = useRef<AudioPlayer | null>(null);

  // Initialize Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const userProfile: UserProfile = {
          uid: firebaseUser.uid,
          email: firebaseUser.email || '',
          displayName: firebaseUser.displayName || 'User',
          photoURL: firebaseUser.photoURL || undefined,
          createdAt: new Date().toISOString(),
          trustScore: 100
        };
        
        // Save/Update user in Firestore
        await setDoc(doc(db, 'users', firebaseUser.uid), userProfile, { merge: true });
        setUser(userProfile);
      } else {
        setUser(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Fetch Location
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          setLocation({
            lat: latitude,
            lng: longitude,
            address: `Near MG Road, Bangalore (Detected via GPS)`
          });
        },
        (error) => console.error("Location error:", error)
      );
    }
  }, []);

  // Fetch Incidents
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'incidents'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Incident));
      setIncidents(data);
    });
    return () => unsubscribe();
  }, [user]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      voiceService.current?.stop();
      audioPlayer.current?.stop();
    };
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = () => signOut(auth);

  const startCall = async () => {
    if (!location) {
      alert("Please enable location services to use the voice agent.");
      return;
    }

    setCurrentView('report');
    setIsCalling(true);
    setTranscripts([]);
    setStatus('Connecting...');

    if (!voiceService.current) voiceService.current = new GeminiVoiceService();
    if (!audioPlayer.current) audioPlayer.current = new AudioPlayer();

    await voiceService.current.connect({
      onAudioOutput: (base64) => audioPlayer.current?.playBase64(base64),
      onTranscript: (text, isUser) => setTranscripts(prev => [...prev, { text, isUser }]),
      onInterrupted: () => audioPlayer.current?.stop(),
      onError: (err) => {
        setStatus('Error');
        console.error(err);
      },
      onStatusChange: (s) => setStatus(s),
      onProofRequested: () => {
        setIsProofModalOpen(true);
        setTranscripts(prev => [...prev, { text: "System: AI Agent is requesting photographic proof.", isUser: false }]);
      },
      onIncidentTypeDetected: (type) => {
        setDetectedIncidentType(type);
      }
    }, location);
  };

  const endCall = () => {
    voiceService.current?.stop();
    audioPlayer.current?.stop();
    setIsCalling(false);
    setStatus('Idle');
    setHasProof(false);
    setIsProofModalOpen(false);
    setMatchResult(null);
    setIsMatching(false);
    setDetectedIncidentType(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsMatching(true);
    setMatchResult(null);

    if (!matchingService.current) matchingService.current = new ImageMatchingService();

    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64 = reader.result as string;
      const result = await matchingService.current!.matchImageToIncidents(base64, incidents);
      
      setIsMatching(false);
      setMatchResult(result);
      
      if (!result.isMatch) {
        setHasProof(true);
        setIsProofModalOpen(false);
        if (isCalling) {
          setTranscripts(prev => [...prev, { text: "System: Photo analyzed. No duplicates found. Proceeding...", isUser: false }]);
          voiceService.current?.confirmProof();
        }
      } else {
        if (isCalling) {
          setTranscripts(prev => [...prev, { text: `System: Potential duplicate detected! ${result.reason}`, isUser: false }]);
        }
      }
    };
    reader.readAsDataURL(file);
  };

  const toggleProof = () => {
    if (hasProof) {
      setHasProof(false);
      setMatchResult(null);
    } else {
      fileInputRef.current?.click();
    }
  };

  const filteredIncidents = useMemo(() => {
    if (!searchQuery.trim()) return incidents;
    const query = searchQuery.toLowerCase();
    return incidents.filter(inc => 
      inc.type.toLowerCase().includes(query) || 
      inc.description.toLowerCase().includes(query)
    );
  }, [incidents, searchQuery]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-bg">
        <Activity className="w-12 h-12 text-brand-primary animate-pulse" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-brand-bg p-4 neo-grid">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full glass-morphism p-10 rounded-3xl text-center"
        >
          <div className="w-20 h-20 bg-brand-primary/20 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Shield className="w-10 h-10 text-brand-primary" />
          </div>
          <h1 className="text-4xl font-bold mb-4 font-mono tracking-tighter text-white">CIVICVOICE AI</h1>
          <p className="text-gray-400 mb-8">
            The next generation of autonomous urban management. Report issues, track resolutions, and improve your city with voice.
          </p>
          <button 
            onClick={handleLogin}
            className="w-full py-4 bg-brand-primary text-black font-bold rounded-xl flex items-center justify-center gap-3 hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            <User className="w-5 h-5" />
            Sign in with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="h-screen bg-brand-bg flex flex-col overflow-hidden text-white">
        
        {/* Top Navigation Bar */}
        <nav className="h-20 border-b border-brand-border bg-brand-card/80 backdrop-blur-xl flex items-center justify-between px-6 z-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-brand-primary/10 rounded-lg flex items-center justify-center">
              <Shield className="w-6 h-6 text-brand-primary" />
            </div>
            <span className="font-mono font-bold text-xl tracking-tighter">CIVICVOICE</span>
          </div>

          <div className="hidden md:flex items-center gap-8">
            {[
              { id: 'home', label: 'Home', icon: Activity },
              { id: 'report', label: 'Report', icon: Mic },
              { id: 'map', label: 'Location', icon: MapPin },
              { id: 'dashboard', label: 'Dashboard', icon: Layers },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  if (isCalling && item.id !== 'report') endCall();
                  setCurrentView(item.id as any);
                }}
                className={cn(
                  "flex items-center gap-2 text-sm font-mono uppercase tracking-widest transition-all",
                  currentView === item.id ? "text-brand-primary" : "text-gray-500 hover:text-white"
                )}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-xs font-bold">{user.displayName}</span>
              <span className="text-[10px] text-brand-primary font-mono uppercase">Trust: {user.trustScore}</span>
            </div>
            <button onClick={handleLogout} className="p-2 text-gray-500 hover:text-white transition-colors">
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </nav>

        {/* Main Content Area */}
        <main className="flex-1 relative overflow-hidden neo-grid">
          <AnimatePresence mode="wait">
            
            {/* HOME VIEW */}
            {currentView === 'home' && (
              <motion.div 
                key="home"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.05 }}
                className="absolute inset-0 flex flex-col items-center p-6 text-center overflow-y-auto"
              >
                <div className="max-w-3xl my-auto py-12">
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                  >
                    <h1 className="text-6xl md:text-8xl font-bold mb-6 tracking-tighter leading-none">
                      REPORT ISSUES WITH <br />
                      <span className="text-brand-primary">YOUR VOICE.</span>
                    </h1>
                    <p className="text-xl text-gray-400 mb-10 max-w-2xl mx-auto">
                      CivicVoice AI is your autonomous urban assistant. No forms, no waiting. Just speak, and we'll handle the rest.
                    </p>
                  </motion.div>

                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.4 }}
                    className="flex flex-wrap justify-center gap-4"
                  >
                    <button 
                      onClick={() => setCurrentView('report')}
                      className="px-8 py-4 bg-brand-primary text-black font-bold rounded-2xl flex items-center gap-3 hover:scale-105 transition-transform"
                    >
                      <Mic className="w-6 h-6" />
                      START REPORTING
                    </button>
                    <button 
                      onClick={() => setCurrentView('map')}
                      className="px-8 py-4 glass-morphism text-white font-bold rounded-2xl flex items-center gap-3 hover:bg-white/10 transition-colors"
                    >
                      <MapPin className="w-6 h-6" />
                      VIEW CITY MAP
                    </button>
                  </motion.div>

                  <div className="mt-20 grid grid-cols-1 md:grid-cols-3 gap-6">
                    {[
                      { icon: Activity, title: "Real-Time", desc: "Instant processing with Gemini Live API" },
                      { icon: Shield, title: "Autonomous", desc: "AI creates and tracks tickets automatically" },
                      { icon: MapPin, title: "Location-Aware", desc: "Automatic GPS tagging for all reports" }
                    ].map((feature, i) => (
                      <div key={i} className="p-6 glass-morphism rounded-2xl text-left border-white/5">
                        <feature.icon className="w-8 h-8 text-brand-primary mb-4" />
                        <h3 className="font-bold mb-2">{feature.title}</h3>
                        <p className="text-sm text-gray-400">{feature.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {/* REPORT VIEW (Voice Agent) */}
            {currentView === 'report' && (
              <motion.div 
                key="report"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="absolute inset-0 flex flex-col items-center p-6 overflow-y-auto"
              >
                <div className="max-w-2xl w-full flex flex-col items-center py-8">
                  <motion.div 
                    animate={{ opacity: [0.5, 1, 0.5] }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="mb-8 flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10"
                  >
                    <div className={cn("w-2 h-2 rounded-full", isCalling ? "bg-brand-primary" : "bg-gray-500")} />
                    <span className="text-xs font-mono uppercase tracking-widest">{status}</span>
                  </motion.div>

                  <div className="relative mb-12">
                    <AnimatePresence>
                      {isCalling && (
                        <motion.div 
                          initial={{ scale: 0.8, opacity: 0 }}
                          animate={{ scale: 1.5, opacity: 0 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 2, repeat: Infinity }}
                          className="absolute inset-0 bg-brand-primary/20 rounded-full"
                        />
                      )}
                    </AnimatePresence>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={isCalling ? endCall : startCall}
                      className={cn(
                        "w-32 h-32 rounded-full flex items-center justify-center transition-all duration-500 shadow-2xl relative z-10",
                        isCalling ? "bg-red-500 text-white rotate-[135deg]" : "bg-brand-primary text-black"
                      )}
                    >
                      {isCalling ? <PhoneOff className="w-10 h-10" /> : <Phone className="w-10 h-10" />}
                    </motion.button>
                  </div>

                  <h2 className="text-3xl font-bold mb-2 text-center">
                    {isCalling ? "Listening..." : "Voice Reporting"}
                  </h2>
                  <p className="text-gray-400 text-center mb-12 max-w-sm">
                    {isCalling ? "Talk naturally to report an issue. I'm here to help." : "Click the button to start reporting with your voice."}
                  </p>

                  <AnimatePresence>
                    {isCalling && detectedIncidentType && ['fire', 'medical_emergency', 'police_emergency'].includes(detectedIncidentType) && (
                      <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="w-full mb-8 p-6 bg-red-500/10 border-2 border-red-500/50 rounded-3xl overflow-hidden relative"
                      >
                        <div className="absolute top-0 right-0 p-4 opacity-10">
                          <AlertTriangle className="w-24 h-24 text-red-500" />
                        </div>
                        
                        <div className="flex items-center gap-4 mb-4">
                          <div className="p-3 bg-red-500 rounded-2xl text-white animate-pulse">
                            <Shield className="w-8 h-8" />
                          </div>
                          <div>
                            <h3 className="text-xl font-bold text-red-500 uppercase tracking-tighter">EMERGENCY PROTOCOL ACTIVE</h3>
                            <p className="text-xs text-gray-400 font-mono">TYPE: {detectedIncidentType.replace('_', ' ').toUpperCase()}</p>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                          <div className="space-y-3">
                            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">First Aid / Safety</p>
                            <ul className="text-sm space-y-2">
                              {detectedIncidentType === 'fire' && (
                                <>
                                  <li className="flex gap-2"><div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" /> Evacuate immediately</li>
                                  <li className="flex gap-2"><div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" /> Stay low to avoid smoke</li>
                                  <li className="flex gap-2"><div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" /> Do not use elevators</li>
                                </>
                              )}
                              {detectedIncidentType === 'medical_emergency' && (
                                <>
                                  <li className="flex gap-2"><div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" /> Keep the person still</li>
                                  <li className="flex gap-2"><div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" /> Check for breathing</li>
                                  <li className="flex gap-2"><div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" /> Apply pressure to wounds</li>
                                </>
                              )}
                              {detectedIncidentType === 'police_emergency' && (
                                <>
                                  <li className="flex gap-2"><div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" /> Stay in a safe location</li>
                                  <li className="flex gap-2"><div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" /> Avoid confrontation</li>
                                  <li className="flex gap-2"><div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" /> Lock all doors/entries</li>
                                </>
                              )}
                            </ul>
                          </div>
                          
                          <div className="space-y-3">
                            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Direct Contacts</p>
                            <div className="grid grid-cols-1 gap-2">
                              <a href="tel:101" className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/10 hover:bg-white/10 transition-colors">
                                <span className="text-sm font-bold">FIRE STATION</span>
                                <span className="text-brand-primary font-mono">101</span>
                              </a>
                              <a href="tel:102" className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/10 hover:bg-white/10 transition-colors">
                                <span className="text-sm font-bold">AMBULANCE</span>
                                <span className="text-brand-primary font-mono:">102</span>
                              </a>
                              <a href="tel:100" className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/10 hover:bg-white/10 transition-colors">
                                <span className="text-sm font-bold">POLICE</span>
                                <span className="text-brand-primary font-mono">100</span>
                              </a>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className="w-full h-64 glass-morphism rounded-3xl p-6 overflow-y-auto space-y-4 mb-6">
                    {transcripts.length === 0 && (
                      <div className="h-full flex flex-col items-center justify-center text-gray-600 italic">
                        <Mic className="w-8 h-8 mb-2 opacity-20" />
                        <p className="text-sm">Transcript will appear here...</p>
                      </div>
                    )}
                    {transcripts.map((t, i) => (
                      <div key={i} className={cn("flex flex-col", t.isUser ? "items-end" : "items-start")}>
                        <span className="text-[10px] font-mono uppercase text-gray-500 mb-1">{t.isUser ? user.displayName : 'CivicVoice AI'}</span>
                        <div className={cn("max-w-[80%] px-4 py-2 rounded-2xl text-sm", t.isUser ? "bg-brand-primary text-black" : "bg-white/10 text-white")}>
                          {t.text}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Proof Upload Simulation */}
                  <div className={cn(
                    "w-full flex items-center justify-between p-4 glass-morphism rounded-2xl border-white/5 transition-all duration-500",
                    isProofModalOpen ? "ring-2 ring-brand-primary bg-brand-primary/5" : ""
                  )}>
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "w-10 h-10 rounded-xl flex items-center justify-center", 
                        hasProof ? "bg-brand-primary/20 text-brand-primary" : 
                        isProofModalOpen ? "bg-brand-primary/40 text-brand-primary animate-pulse" : "bg-white/5 text-gray-500"
                      )}>
                        <CheckCircle className="w-6 h-6" />
                      </div>
                      <div>
                        <p className="text-sm font-bold">
                          {hasProof ? "Proof Attached" : isProofModalOpen ? "Awaiting Proof..." : "No Proof Provided"}
                        </p>
                        <p className="text-[10px] text-gray-500 uppercase">Required for non-emergencies</p>
                      </div>
                    </div>
                    <button 
                      onClick={toggleProof}
                      disabled={isMatching}
                      className={cn(
                        "px-4 py-2 rounded-lg text-xs font-bold transition-all",
                        isMatching ? "bg-gray-700 text-gray-400 cursor-not-allowed" :
                        hasProof ? "bg-red-500/20 text-red-500 hover:bg-red-500/30" : "bg-brand-primary text-black hover:opacity-90"
                      )}
                    >
                      {isMatching ? "Analyzing..." : hasProof ? "Remove Proof" : "Upload Image"}
                    </button>
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      onChange={handleFileUpload} 
                      className="hidden" 
                      accept="image/*" 
                    />
                  </div>

                  <AnimatePresence>
                    {matchResult && matchResult.isMatch && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-2xl"
                      >
                        <div className="flex items-center gap-3 mb-2">
                          <AlertTriangle className="w-5 h-5 text-red-500" />
                          <p className="text-sm font-bold text-red-500">DUPLICATE DETECTED</p>
                        </div>
                        <p className="text-xs text-gray-400">{matchResult.reason}</p>
                        <div className="mt-4 flex gap-2">
                          <button 
                            onClick={() => setMatchResult(null)}
                            className="px-3 py-1.5 bg-white/10 rounded-lg text-[10px] font-bold"
                          >
                            REPORT ANYWAY
                          </button>
                          <button 
                            onClick={endCall}
                            className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-[10px] font-bold"
                          >
                            CANCEL REPORT
                          </button>
                        </div>
                      </motion.div>
                    )}

                    {isMatching && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="mt-4 p-4 glass-morphism rounded-2xl flex items-center gap-4 border-brand-primary/30"
                      >
                        <Activity className="w-5 h-5 text-brand-primary animate-spin" />
                        <div>
                          <p className="text-sm font-bold text-brand-primary">AI MATCHING IN PROGRESS</p>
                          <p className="text-[10px] text-gray-400">Comparing your photo with existing city reports...</p>
                        </div>
                      </motion.div>
                    )}

                    {isProofModalOpen && !hasProof && !isMatching && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="mt-4 p-4 bg-brand-primary/20 border border-brand-primary/30 rounded-2xl flex items-center gap-4"
                      >
                        <div className="p-2 bg-brand-primary rounded-lg text-black">
                          <Activity className="w-5 h-5 animate-spin" />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-bold text-brand-primary">AI REQUEST: ATTACH PHOTO</p>
                          <p className="text-[10px] text-gray-400">The agent needs visual evidence to proceed with your non-emergency report.</p>
                        </div>
                        <button 
                          onClick={toggleProof}
                          className="px-4 py-2 bg-brand-primary text-black text-xs font-bold rounded-lg"
                        >
                          ATTACH NOW
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}

            {/* MAP VIEW */}
            {currentView === 'map' && (
              <motion.div 
                key="map"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 flex flex-col p-6"
              >
                <div className="flex-1 rounded-3xl overflow-hidden border border-brand-border relative bg-[#050505] neo-grid">
                  
                  {/* Stylized Technical Map Visualization */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    {/* Radial Radar Rings */}
                    <div className="absolute w-[800px] h-[800px] border border-brand-primary/10 rounded-full" />
                    <div className="absolute w-[600px] h-[600px] border border-brand-primary/10 rounded-full" />
                    <div className="absolute w-[400px] h-[400px] border border-brand-primary/20 rounded-full" />
                    
                    {/* Scanning Line */}
                    <motion.div 
                      animate={{ rotate: 360 }}
                      transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                      className="absolute w-[400px] h-[1px] bg-gradient-to-r from-brand-primary/50 to-transparent origin-left left-1/2 top-1/2"
                    />

                    {/* Grid Overlay */}
                    <div className="absolute inset-0 opacity-20" 
                      style={{ 
                        backgroundImage: 'linear-gradient(#00FF00 1px, transparent 1px), linear-gradient(90deg, #00FF00 1px, transparent 1px)',
                        backgroundSize: '40px 40px'
                      }} 
                    />
                  </div>

                  {/* Incident Markers (Abstract) */}
                  <div className="absolute inset-0">
                    {incidents.map((inc, i) => {
                      // Deterministic random positions for markers based on ID
                      const seed = inc.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                      const top = (seed % 80) + 10;
                      const left = ((seed * 1.5) % 80) + 10;

                      return (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          key={inc.id}
                          style={{ top: `${top}%`, left: `${left}%` }}
                          className="absolute group"
                        >
                          <div className={cn(
                            "w-3 h-3 rounded-full animate-pulse",
                            inc.priority === 'critical' ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-yellow-500 shadow-[0_0_10px_rgba(234,179,8,0.5)]'
                          )} />
                          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 hidden group-hover:block z-20">
                            <div className="glass-morphism p-2 rounded-lg border-white/10 whitespace-nowrap text-[10px] font-mono">
                              <span className="text-brand-primary">[{inc.type}]</span> {inc.id.slice(0,6)}
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}

                    {/* User Location Marker */}
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
                      <div className="relative">
                        <div className="w-4 h-4 bg-brand-primary rounded-full shadow-[0_0_20px_#00FF00]" />
                        <div className="absolute inset-0 w-4 h-4 bg-brand-primary rounded-full animate-pulse-ring" />
                        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 glass-morphism px-3 py-1 rounded-full border-brand-primary/30 whitespace-nowrap">
                          <span className="text-[10px] font-mono font-bold text-brand-primary">YOU (CURRENT_POS)</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  {/* Overlay Info */}
                  <div className="absolute top-6 left-6 max-w-sm space-y-4">
                    <div className="p-6 glass-morphism rounded-2xl border-white/10">
                      <h3 className="text-lg font-bold mb-2 flex items-center gap-2">
                        <Activity className="w-5 h-5 text-brand-primary" />
                        Digital Twin View
                      </h3>
                      <p className="text-sm text-gray-400 mb-4">Abstracted city infrastructure layer. Scanning for anomalies...</p>
                      <div className="flex items-center justify-between text-xs font-mono text-brand-primary">
                        <span>LAT: {location?.lat.toFixed(4)}</span>
                        <span>LNG: {location?.lng.toFixed(4)}</span>
                      </div>
                    </div>

                    <div className="p-6 glass-morphism rounded-2xl border-white/10">
                      <h3 className="text-sm font-mono uppercase text-gray-500 mb-4">Active Nodes</h3>
                      <div className="space-y-2">
                        {incidents.slice(0, 3).map(inc => (
                          <div key={inc.id} className="flex items-center gap-3 text-xs">
                            <div className={cn("w-2 h-2 rounded-full", inc.priority === 'critical' ? 'bg-red-500' : 'bg-yellow-500')} />
                            <span className="flex-1 truncate font-mono">{inc.id.slice(0,8)}: {inc.type}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Bottom Right Telemetry */}
                  <div className="absolute bottom-6 right-6 p-4 glass-morphism rounded-2xl border-white/10 text-[10px] font-mono text-gray-500">
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between gap-4"><span>SIGNAL:</span> <span className="text-brand-primary">OPTIMAL</span></div>
                      <div className="flex justify-between gap-4"><span>SYNC:</span> <span className="text-brand-primary">REAL-TIME</span></div>
                      <div className="flex justify-between gap-4"><span>NODES:</span> <span>{incidents.length}</span></div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* DASHBOARD VIEW */}
            {currentView === 'dashboard' && (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="absolute inset-0 p-6 overflow-y-auto"
              >
                <div className="max-w-6xl mx-auto">
                  <div className="flex items-center justify-between mb-8">
                    <h2 className="text-3xl font-bold font-mono tracking-tighter">INCIDENT DASHBOARD</h2>
                    <div className="flex items-center gap-4">
                      <div className="px-4 py-2 glass-morphism rounded-xl flex items-center gap-2">
                        <Search className="w-4 h-4 text-gray-500" />
                        <input 
                          type="text" 
                          placeholder="Search reports..." 
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="bg-transparent border-none outline-none text-sm text-white placeholder:text-gray-600" 
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {filteredIncidents.length === 0 ? (
                      <div className="col-span-full py-20 text-center">
                        <Search className="w-12 h-12 text-gray-700 mx-auto mb-4" />
                        <p className="text-gray-500">No reports match your search criteria.</p>
                      </div>
                    ) : (
                      filteredIncidents.map((incident) => (
                        <motion.div 
                          layout
                          key={incident.id}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="p-6 rounded-3xl glass-morphism border-white/5 hover:border-brand-primary/30 transition-all group"
                        >
                        <div className="flex items-start justify-between mb-4">
                          <div className={cn(
                            "p-3 rounded-xl",
                            ['fire', 'medical_emergency', 'police_emergency'].includes(incident.type) ? "bg-red-500/20 text-red-500" :
                            incident.type === 'road_damage' ? "bg-orange-500/20 text-orange-500" :
                            incident.type === 'electrical' ? "bg-yellow-500/20 text-yellow-500" :
                            "bg-blue-500/20 text-blue-500"
                          )}>
                            <AlertTriangle className="w-6 h-6" />
                          </div>
                          <span className={cn(
                            "text-[10px] px-3 py-1 rounded-full font-mono uppercase",
                            incident.priority === 'critical' ? "bg-red-500/20 text-red-500" : "bg-white/10 text-gray-400"
                          )}>
                            {incident.priority}
                          </span>
                        </div>
                        <h3 className="text-lg font-bold mb-2 uppercase font-mono tracking-tight">{incident.type.replace('_', ' ')}</h3>
                        <p className="text-sm text-gray-400 mb-6 line-clamp-3">{incident.description}</p>
                        
                        <div className="space-y-3 mb-6">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-gray-500">Proof</span>
                            <span className={cn("font-bold uppercase", incident.hasProof ? "text-brand-primary" : "text-red-500")}>
                              {incident.hasProof ? 'Verified' : 'None'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-gray-500">Status</span>
                            <span className="text-brand-primary uppercase font-bold">{incident.status}</span>
                          </div>
                          <div className="flex items-center justify-between text-xs p-2 bg-white/5 rounded-lg border border-white/5">
                            <div className="flex items-center gap-2 text-gray-500">
                              <Clock className="w-3 h-3" />
                              <span>ETA</span>
                            </div>
                            <span className={cn(
                              "font-bold font-mono",
                              incident.eta?.includes('Immediate') ? "text-red-500 animate-pulse" : "text-white"
                            )}>
                              {incident.eta || 'Calculating...'}
                            </span>
                          </div>
                        </div>

                        <div className="pt-4 border-t border-white/5 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-brand-primary/20 flex items-center justify-center text-[10px] text-brand-primary font-bold">
                              {incident.reporterName[0]}
                            </div>
                            <span className="text-[10px] text-gray-500 uppercase">{incident.reporterName}</span>
                          </div>
                          <span className="text-[10px] text-gray-500">{new Date(incident.createdAt).toLocaleDateString()}</span>
                        </div>
                      </motion.div>
                    ))
                  )}
                </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Mobile Navigation */}
        <div className="md:hidden h-20 border-t border-brand-border bg-brand-card/80 backdrop-blur-xl flex items-center justify-around px-4">
          {[
            { id: 'home', icon: Activity },
            { id: 'report', icon: Mic },
            { id: 'map', icon: MapPin },
            { id: 'dashboard', icon: Layers },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setCurrentView(item.id as any)}
              className={cn(
                "p-3 rounded-xl transition-all",
                currentView === item.id ? "bg-brand-primary text-black" : "text-gray-500"
              )}
            >
              <item.icon className="w-6 h-6" />
            </button>
          ))}
        </div>
      </div>
    </ErrorBoundary>
  );
}
