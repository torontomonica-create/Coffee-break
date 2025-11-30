import React, { useState, useEffect, useRef, useCallback } from 'react';
import { CoffeeType, AppStatus, CoffeeStats, ChatMessage } from './types';
import { MAX_SIPS, DEFAULT_DURATION, MIN_DURATION, MAX_DURATION, DURATION_STEP, COFFEE_CONFIG } from './constants';
import { CoffeeCup } from './components/CoffeeCup';
import { Timer } from './components/Timer';
import { ChatOverlay } from './components/ChatOverlay';
import { StatsFooter } from './components/StatsFooter';
import { Coffee, RotateCw, LogOut, Clock, ChevronRight } from 'lucide-react';
import { GoogleGenerativeAI } from "@google/generative-ai";

// --- Constants for Persistence & Sync ---
const STORAGE_KEY = 'coffee_break_stats_v1';
const CHANNEL_NAME = 'coffee_break_channel';
const SESSION_ID = Math.random().toString(36).substr(2, 9); // Unique ID for this tab

const App: React.FC = () => {
  // --- State ---
  const [status, setStatus] = useState<AppStatus>(AppStatus.MENU);
  const [selectedCoffee, setSelectedCoffee] = useState<CoffeeType | null>(null);
  const [breakDuration, setBreakDuration] = useState(DEFAULT_DURATION);
  const [sipsTaken, setSipsTaken] = useState(0);
  const [timeLeft, setTimeLeft] = useState(DEFAULT_DURATION);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  
  // Real-time tracking
  const [activePeers, setActivePeers] = useState<Record<string, number>>({ [SESSION_ID]: Date.now() });
  
  // Stats (Initialized from LocalStorage)
  const [stats, setStats] = useState<CoffeeStats>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn("Failed to load stats from localStorage", e);
    }
    return {
      iced: 0,
      double: 0,
      cappuccino: 0,
      totalUsers: 1,
    };
  });

  // Refs
  const timerRef = useRef<number | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const baristaChatRef = useRef<Chat | null>(null);

  // --- Helpers ---
  
  const mapTypeToStatKey = (type: CoffeeType): keyof CoffeeStats | null => {
    if (type === CoffeeType.ICED_COFFEE) return 'iced';
    if (type === CoffeeType.DOUBLE_DOUBLE) return 'double';
    if (type === CoffeeType.CAPPUCCINO) return 'cappuccino';
    return null;
  };

  const saveStatsToStorage = (newStats: CoffeeStats) => {
    try {
      // We don't save totalUsers to storage as it's transient
      const storageData = { ...newStats, totalUsers: 0 }; 
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storageData));
    } catch (e) {
      console.warn("Failed to save stats to localStorage", e);
    }
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // --- Real-time Logic (BroadcastChannel) ---
  useEffect(() => {
    // 1. Setup Channel
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;

    channel.onmessage = (event) => {
      const { type, payload } = event.data;

      if (type === 'HEARTBEAT') {
        // Record that we saw this peer
        setActivePeers(prev => ({ ...prev, [payload.id]: Date.now() }));
      } else if (type === 'CUP_FINISHED') {
        // Someone else finished a coffee
        setStats(prev => {
           const newStats = { ...prev };
           const key = mapTypeToStatKey(payload.coffeeType);
           if (key) {
             newStats[key]++;
           }
           // Sync to local storage to keep count consistent
           saveStatsToStorage(newStats);
           return newStats;
        });
      }
    };

    // 2. Heartbeat Sender (I'm alive!)
    const heartbeatInterval = setInterval(() => {
      channel.postMessage({ type: 'HEARTBEAT', payload: { id: SESSION_ID } });
      
      // Also prune old peers who haven't sent a heartbeat in 5 seconds
      setActivePeers(prev => {
        const now = Date.now();
        const next = { ...prev };
        let changed = false;
        
        // Always keep self
        next[SESSION_ID] = now;

        Object.keys(next).forEach(id => {
          if (id !== SESSION_ID && now - next[id] > 5000) {
            delete next[id];
            changed = true;
          }
        });
        
        return changed ? next : prev;
      });
    }, 1000);

    // Initial announcement
    channel.postMessage({ type: 'HEARTBEAT', payload: { id: SESSION_ID } });

    return () => {
      clearInterval(heartbeatInterval);
      channel.close();
    };
  }, []);

  // Sync total users count to stats object for display
  useEffect(() => {
    setStats(prev => ({
      ...prev,
      totalUsers: Object.keys(activePeers).length
    }));
  }, [activePeers]);

  // --- Effects ---

  // Timer Countdown
  useEffect(() => {
    if (status === AppStatus.DRINKING) {
      timerRef.current = window.setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            handleFinish();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // --- Handlers ---

  const initBaristaChat = async (coffeeType: CoffeeType) => {
    // Reset previous session chat
    baristaChatRef.current = null;

    // Fallback immediately if no key provided
    if (!process.env.API_KEY) {
      setMessages([{
        id: 'barista-no-key',
        text: "API Key 설정이 필요합니다. (Netlify 설정 확인)",
        isUser: false,
        sender: 'Barista',
        timestamp: Date.now()
      }]);
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const coffeeName = COFFEE_CONFIG[coffeeType].name;
      
      // Context: Calculate how many cups user had including this one
      const totalCups = stats.iced + stats.double + stats.cappuccino + 1;
      
      const newChat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction: `You are a cool, humorous, and chill barista at a virtual coffee shop. 
          A customer is taking a ${formatDuration(breakDuration)} break with a "${coffeeName}".
          This is their cup #${totalCups} today.
          
          - Keep responses EXTREMELY SHORT (max 1 sentence, under 15 words).
          - Be funny, witty, and a bit dry.
          - If they've had a lot of coffee (more than 3), comment on their jitters.
          - Don't be overly enthusiastic or formal.
          - Just casual banter.`
        }
      });
      
      baristaChatRef.current = newChat;

      // Generate initial greeting
      const response = await newChat.sendMessage({
        message: `I just ordered a ${coffeeName}. Serve it and say something short and funny.`
      });
      
      setMessages([{
        id: 'barista-init',
        text: response.text || "Here's your fuel. Enjoy.",
        isUser: false,
        sender: 'Barista',
        timestamp: Date.now()
      }]);

    } catch (error) {
      console.error("Failed to init barista", error);
      // Fallback greeting if API fails
      setMessages([{
        id: 'barista-fallback',
        text: "Coffee's ready. (AI Connection Issue)",
        isUser: false,
        sender: 'Barista',
        timestamp: Date.now()
      }]);
    }
  };

  const handleStart = (type: CoffeeType) => {
    setSelectedCoffee(type);
    setSipsTaken(0);
    setTimeLeft(breakDuration); // Use selected duration
    setMessages([]); // Clear old messages
    setStatus(AppStatus.DRINKING);
    
    // Start the Barista conversation
    initBaristaChat(type);
  };

  const handleSip = () => {
    if (status !== AppStatus.DRINKING) return;
    
    setSipsTaken(prev => {
      const newSips = prev + 1;
      if (newSips >= MAX_SIPS) {
        handleFinish(true); // true = manually finished by drinking
      }
      return newSips;
    });
  };

  const handleFinish = useCallback((finishedByDrinking = false) => {
    setStatus(AppStatus.FINISHED);
    if (timerRef.current) clearInterval(timerRef.current);

    // Only count stats if actually finished drinking
    if (finishedByDrinking && selectedCoffee) {
      setStats(prev => {
        const newStats = { ...prev };
        const key = mapTypeToStatKey(selectedCoffee);
        if (key) {
          newStats[key]++;
        }
        saveStatsToStorage(newStats);
        return newStats;
      });

      // Broadcast to other tabs (Stats only)
      channelRef.current?.postMessage({
        type: 'CUP_FINISHED',
        payload: { coffeeType: selectedCoffee }
      });
    }
  }, [selectedCoffee]);

  const handleRestart = () => {
    setStatus(AppStatus.MENU);
    setSelectedCoffee(null);
  };

  const handleSendMessage = async (text: string) => {
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      text,
      isUser: true,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMsg]);

    // Send to Barista AI
    if (baristaChatRef.current) {
      try {
        const result = await baristaChatRef.current.sendMessage({ message: text });
        const baristaMsg: ChatMessage = {
          id: Date.now().toString() + '_b',
          text: result.text || "...",
          isUser: false,
          sender: 'Barista',
          timestamp: Date.now()
        };
        setMessages(prev => [...prev, baristaMsg]);
      } catch (err) {
        console.error("Barista error", err);
      }
    }
  };

  // --- Renders ---

  const renderMenu = () => (
    <div className="flex flex-col h-full w-full max-w-2xl mx-auto p-6 pt-[max(2rem,env(safe-area-inset-top))] animate-fade-in bg-white">
      {/* Header */}
      <div className="flex flex-col items-center mt-6 mb-10 text-center">
        <h1 className="text-5xl font-extrabold text-primary mb-3 tracking-tight">Coffee Break</h1>
        <p className="text-stone-500 text-xl font-medium">
          Select your drink and relax.
        </p>
        <p className="text-stone-400 text-sm mt-3 font-bold uppercase tracking-widest">
          Created by: Miyoung Cho
        </p>
      </div>

      {/* Break Duration Section */}
      <div className="mb-10 px-2">
        <div className="flex justify-between items-end mb-4">
           <div className="flex items-center gap-2 text-primary font-bold text-xl">
             <Clock size={24} strokeWidth={2.5} />
             <span>Duration</span>
           </div>
           <span className="text-white bg-primary px-4 py-1.5 rounded-full text-base font-bold shadow-md">
             {formatDuration(breakDuration)}
           </span>
        </div>
        
        <div className="relative h-8 flex items-center">
          <input
            type="range"
            min={MIN_DURATION}
            max={MAX_DURATION}
            step={DURATION_STEP}
            value={breakDuration}
            onChange={(e) => setBreakDuration(Number(e.target.value))}
            className="w-full h-3 rounded-lg appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-stone-300"
          />
        </div>
        <div className="flex justify-between text-xs text-stone-400 mt-2 font-bold uppercase tracking-wider">
           <span>1 min</span>
           <span>5 min</span>
        </div>
      </div>

      {/* Coffee Selection List */}
      <div className="grid gap-5 flex-1 overflow-y-auto pb-24 no-scrollbar">
        {Object.entries(COFFEE_CONFIG).map(([key, config]) => (
          <button
            key={key}
            onClick={() => handleStart(key as CoffeeType)}
            className="group relative flex items-center p-6 bg-white rounded-[28px] shadow-sm border border-stone-100 hover:shadow-xl hover:border-stone-200 transition-all active:scale-[0.98] duration-300"
          >
            <div className={`w-20 h-20 rounded-full ${config.color} mr-6 flex-shrink-0 shadow-md flex items-center justify-center`}>
                <Coffee className="text-white/70" size={36} />
            </div>
            <div className="text-left flex-1">
              <h3 className="font-bold text-2xl text-primary mb-1">
                {config.name}
              </h3>
              <p className="text-base text-stone-500 font-medium">{config.description}</p>
            </div>
            <div className="text-stone-300 group-hover:text-primary transition-colors">
              <ChevronRight size={28} />
            </div>
          </button>
        ))}
      </div>
      
      <div className="fixed bottom-0 left-0 w-full z-20">
        <StatsFooter stats={stats} />
      </div>
    </div>
  );

  const renderActiveBreak = () => (
    <div className="relative h-full flex flex-col bg-white overflow-hidden w-full">
      {/* Header - Absolute top */}
      <div className="absolute top-0 left-0 w-full p-4 pt-[max(1.5rem,env(safe-area-inset-top))] flex justify-between items-start z-30 pointer-events-none">
         <div className="pointer-events-auto">
             <button onClick={() => handleFinish(false)} className="p-3 bg-white/80 rounded-full text-primary hover:bg-stone-100 backdrop-blur-md shadow-md transition-colors">
                 <LogOut size={24} />
             </button>
         </div>
         <div className="pointer-events-auto">
           <Timer secondsRemaining={timeLeft} onTimeUp={() => handleFinish(false)} />
         </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 relative flex flex-col w-full h-full">
        
        {/* Coffee Layer */}
        <div className="absolute inset-0 flex items-start justify-center pt-[15vh] z-0 pointer-events-auto px-4">
          {selectedCoffee && (
            <CoffeeCup 
              type={selectedCoffee} 
              sipsTaken={sipsTaken} 
              onSip={handleSip} 
            />
          )}
        </div>

        {/* Chat Layer */}
        <div className="absolute inset-0 z-10 pointer-events-none flex flex-col justify-end">
           <ChatOverlay messages={messages} onSendMessage={handleSendMessage} />
        </div>
      </div>
      
       {/* Footer */}
       <div className="relative z-20 w-full flex-shrink-0 bg-white">
        <StatsFooter stats={stats} />
      </div>
    </div>
  );

  const renderFinished = () => (
    <div className="flex flex-col items-center justify-center h-full w-full max-w-2xl mx-auto p-8 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] bg-white text-center animate-fade-in select-none">
       <div className="mb-12 p-8 bg-stone-50 rounded-full shadow-inner">
        {sipsTaken >= MAX_SIPS ? (
            <div className="text-7xl">😋</div>
        ) : (
             <div className="text-7xl">⏰</div>
        )}
       </div>
      
      <h2 className="text-5xl font-black text-primary mb-5 tracking-tight">
        {sipsTaken >= MAX_SIPS ? "All done!" : "Break's Over"}
      </h2>
      
      <p className="text-2xl text-stone-500 mb-12 max-w-xs leading-relaxed font-medium">
        {sipsTaken >= MAX_SIPS 
          ? "Your break is up.\nRecharged and ready!" 
          : "Time is up.\nLet's finish the coffee next time."}
      </p>

      <div className="p-8 bg-surface rounded-3xl mb-12 w-full max-w-xs mx-auto border border-stone-100">
          <p className="text-sm font-bold text-stone-400 uppercase tracking-widest mb-3">My Break Stats</p>
          <div className="flex justify-between items-center text-primary font-bold">
            <span className="text-xl">{COFFEE_CONFIG[selectedCoffee!].name}</span>
            <span className="text-3xl">{Math.round((sipsTaken / MAX_SIPS) * 100)}%</span>
          </div>
      </div>

      <button
        onClick={handleRestart}
        className="flex items-center justify-center space-x-3 px-10 py-5 bg-primary text-white rounded-full shadow-lg hover:bg-stone-800 hover:shadow-xl transition-all active:scale-95 w-full max-w-sm"
      >
        <RotateCw size={24} strokeWidth={2.5} />
        <span className="font-bold text-xl">Drink Again</span>
      </button>
      
      <p className="mt-10 text-stone-400 text-base font-medium">Let's drink together again soon!</p>
    </div>
  );

  return (
    <div className="w-full h-[100dvh] bg-white overflow-hidden text-primary">
      {status === AppStatus.MENU && renderMenu()}
      {status === AppStatus.DRINKING && renderActiveBreak()}
      {status === AppStatus.FINISHED && renderFinished()}
    </div>
  );
};

export default App;
