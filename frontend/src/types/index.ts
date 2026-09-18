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
 * 最近一次本地（前端）分析的完整快照：
 * 设置（导联/心率）与该次结论、指标、波形绑定存储，保证恢复后整屏为同一次数据
 */
export interface LocalAnalysisSnapshot {
  version: number;
  savedAt: number;
  selectedLead: string;
  heartRate: number;
  duration: number;
  samplingRate: number;
  ecgData: ECGLead;
  hrvData: HRVData;
  arrhythmiaEvents: ArrhythmiaEvent[];
  rhythmDiagnosis: string;
}

export const LEAD_NAMES: string[] = [
  'I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'
];
