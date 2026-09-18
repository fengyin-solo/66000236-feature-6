export interface ECGLead {
  leadName: string;
  samplingRate: number;
  duration: number;
  samples: number[];
  rPeaks: RPeak[];
}

export interface RPeak {
  index: number;
  time: number;
  amplitude: number;
}

export interface HRVData {
  heartRate: number;
  sdnn: number;
  rmssd: number;
  pnn50: number;
  nnIntervals: number[];
}

export interface ArrhythmiaEvent {
  eventType: 'normal' | 'tachycardia' | 'bradycardia' | 'st_elevation' | 'atrial_fibrillation' | 'premature_ventricular_contraction';
  confidence: number;
  description: string;
  timestamp: number;
}

export interface ECGAnalysisResponse {
  lead: ECGLead;
  hrv: HRVData;
  arrhythmiaEvents: ArrhythmiaEvent[];
  rhythmDiagnosis: string;
}

export interface ECGAnalysisRequest {
  leadName: string;
  duration: number;
  samplingRate: number;
  heartRate: number;
}

/**
 * 最近一次本地分析的完整快照：
 * 导联、心率设置与该次分析产生的波形、指标、事件、结论必须来自同一次运行
 */
export interface LocalAnalysisSnapshot {
  version: 1;
  savedAt: number;
  selectedLead: string;
  heartRate: number;
  samplingRate: number;
  duration: number;
  ecgData: ECGLead;
  hrvData: HRVData;
  arrhythmiaEvents: ArrhythmiaEvent[];
  rhythmDiagnosis: string;
}

export const LEAD_NAMES: string[] = [
  'I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'
];
