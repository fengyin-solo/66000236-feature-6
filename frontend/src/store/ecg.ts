import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ECGLead, HRVData, RPeak, ArrhythmiaEvent, ECGAnalysisResponse, LocalAnalysisSnapshot } from '../types';

const LOCAL_SNAPSHOT_KEY = 'ecg-monitor:last-local-analysis:v1';
const LOCAL_SNAPSHOT_VERSION = 1;
const EVENT_TYPES = [
  'normal',
  'tachycardia',
  'bradycardia',
  'st_elevation',
  'atrial_fibrillation',
  'premature_ventricular_contraction',
] as const;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isRPeak(v: unknown): v is RPeak {
  const o = v as RPeak;
  return (
    !!o &&
    typeof o === 'object' &&
    isFiniteNumber(o.index) &&
    isFiniteNumber(o.time) &&
    isFiniteNumber(o.amplitude)
  );
}

function isECGLead(v: unknown): v is ECGLead {
  const o = v as ECGLead;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.leadName === 'string' &&
    o.leadName.length > 0 &&
    isFiniteNumber(o.samplingRate) && o.samplingRate > 0 &&
    isFiniteNumber(o.duration) && o.duration > 0 &&
    Array.isArray(o.samples) && o.samples.length > 0 &&
    o.samples.every(isFiniteNumber) &&
    Array.isArray(o.rPeaks) && o.rPeaks.every(isRPeak)
  );
}

function isHRVData(v: unknown): v is HRVData {
  const o = v as HRVData;
  return (
    !!o &&
    typeof o === 'object' &&
    isFiniteNumber(o.heartRate) &&
    isFiniteNumber(o.sdnn) &&
    isFiniteNumber(o.rmssd) &&
    isFiniteNumber(o.pnn50) &&
    Array.isArray(o.nnIntervals) && o.nnIntervals.every(isFiniteNumber)
  );
}

function isArrhythmiaEvent(v: unknown): v is ArrhythmiaEvent {
  const o = v as ArrhythmiaEvent;
  return (
    !!o &&
    typeof o === 'object' &&
    (EVENT_TYPES as readonly string[]).includes(o.eventType) &&
    isFiniteNumber(o.confidence) &&
    typeof o.description === 'string' &&
    isFiniteNumber(o.timestamp)
  );
}

/**
 * 校验快照结构完整：设置与结论、指标、波形必须来自同一次分析，缺一不可。
 * 字段缺失或类型不符（记录残缺）时返回 false，按空状态处理。
 */
function isValidSnapshot(v: unknown): v is LocalAnalysisSnapshot {
  const o = v as LocalAnalysisSnapshot;
  if (!o || typeof o !== 'object') return false;
  if (o.version !== LOCAL_SNAPSHOT_VERSION) return false;
  if (!isFiniteNumber(o.savedAt)) return false;
  if (typeof o.selectedLead !== 'string' || o.selectedLead.length === 0) return false;
  if (!isFiniteNumber(o.heartRate) || o.heartRate <= 0) return false;
  if (!isFiniteNumber(o.duration) || o.duration <= 0) return false;
  if (!isFiniteNumber(o.samplingRate) || o.samplingRate <= 0) return false;
  if (!isECGLead(o.ecgData)) return false;
  if (!isHRVData(o.hrvData)) return false;
  if (!Array.isArray(o.arrhythmiaEvents) || o.arrhythmiaEvents.length === 0) return false;
  if (!o.arrhythmiaEvents.every(isArrhythmiaEvent)) return false;
  if (typeof o.rhythmDiagnosis !== 'string' || o.rhythmDiagnosis.length === 0) return false;
  // 跨区一致性：波形与设置必须对得上
  if (o.ecgData.leadName !== o.selectedLead) return false;
  if (o.ecgData.samplingRate !== o.samplingRate) return false;
  if (o.ecgData.duration !== o.duration) return false;
  return true;
}

/** 一次性写入整条快照，避免旧的心率过快/过慢结论与新结论混在一起 */
function persistSnapshot(snapshot: LocalAnalysisSnapshot): void {
  try {
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (error) {
    // 存储不可用或配额不足时不影响本次分析结果的展示
    console.error('Failed to persist local ECG analysis:', error);
  }
}

/**
 * 读取最近一次本地分析快照。
 * 无记录或记录内容残缺（JSON 损坏、字段缺失、校验失败）时清除坏记录并返回 null。
 */
function loadSnapshot(): LocalAnalysisSnapshot | null {
  try {
    const raw = localStorage.getItem(LOCAL_SNAPSHOT_KEY);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      localStorage.removeItem(LOCAL_SNAPSHOT_KEY);
      return null;
    }
    if (!isValidSnapshot(parsed)) {
      localStorage.removeItem(LOCAL_SNAPSHOT_KEY);
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('Failed to load local ECG analysis:', error);
    return null;
  }
}

// Gaussian function for PQRST wave simulation
function gaussian(x: number, amplitude: number, center: number, width: number): number {
  return amplitude * Math.exp(-((x - center) ** 2) / (2 * width ** 2));
}

// Lead-specific PQRST configuration
interface LeadConfig {
  pAmplitude: number;
  qAmplitude: number;
  rAmplitude: number;
  sAmplitude: number;
  tAmplitude: number;
  stElevation: number;
}

const LEAD_CONFIGS: Record<string, LeadConfig> = {
  'I': { pAmplitude: 0.12, qAmplitude: -0.05, rAmplitude: 0.8, sAmplitude: -0.1, tAmplitude: 0.25, stElevation: 0.0 },
  'II': { pAmplitude: 0.15, qAmplitude: -0.1, rAmplitude: 1.2, sAmplitude: -0.2, tAmplitude: 0.3, stElevation: 0.0 },
  'III': { pAmplitude: 0.10, qAmplitude: -0.08, rAmplitude: 0.9, sAmplitude: -0.15, tAmplitude: 0.2, stElevation: 0.0 },
  'aVR': { pAmplitude: -0.10, qAmplitude: 0.05, rAmplitude: -0.8, sAmplitude: 0.1, tAmplitude: -0.2, stElevation: 0.0 },
  'aVL': { pAmplitude: 0.10, qAmplitude: -0.03, rAmplitude: 0.6, sAmplitude: -0.05, tAmplitude: 0.2, stElevation: 0.0 },
  'aVF': { pAmplitude: 0.13, qAmplitude: -0.09, rAmplitude: 1.0, sAmplitude: -0.18, tAmplitude: 0.28, stElevation: 0.0 },
  'V1': { pAmplitude: 0.08, qAmplitude: 0.0, rAmplitude: 0.3, sAmplitude: -0.8, tAmplitude: 0.15, stElevation: 0.0 },
  'V2': { pAmplitude: 0.10, qAmplitude: -0.02, rAmplitude: 0.6, sAmplitude: -0.6, tAmplitude: 0.25, stElevation: 0.0 },
  'V3': { pAmplitude: 0.10, qAmplitude: -0.05, rAmplitude: 0.9, sAmplitude: -0.4, tAmplitude: 0.3, stElevation: 0.0 },
  'V4': { pAmplitude: 0.12, qAmplitude: -0.08, rAmplitude: 1.3, sAmplitude: -0.25, tAmplitude: 0.35, stElevation: 0.0 },
  'V5': { pAmplitude: 0.12, qAmplitude: -0.1, rAmplitude: 1.1, sAmplitude: -0.15, tAmplitude: 0.3, stElevation: 0.0 },
  'V6': { pAmplitude: 0.10, qAmplitude: -0.08, rAmplitude: 0.9, sAmplitude: -0.1, tAmplitude: 0.25, stElevation: 0.0 },
};

// Generate a single PQRST cycle at normalized time t (0 to 1)
function generatePQRSTCycle(tNorm: number, config: LeadConfig): number {
  const p = gaussian(tNorm, config.pAmplitude, 0.12, 0.035);
  const q = gaussian(tNorm, config.qAmplitude, 0.22, 0.012);
  const r = gaussian(tNorm, config.rAmplitude, 0.26, 0.012);
  const s = gaussian(tNorm, config.sAmplitude, 0.30, 0.015);
  const tWave = gaussian(tNorm, config.tAmplitude, 0.48, 0.055);
  const st = (tNorm > 0.32 && tNorm < 0.42) ? config.stElevation : 0.0;
  return p + q + r + s + tWave + st;
}

export const useECGStore = defineStore('ecg', () => {
  // State
  const selectedLead = ref<string>('II');
  const heartRate = ref<number>(72);
  const samplingRate = ref<number>(500);
  const duration = ref<number>(10);
  const isMonitoring = ref<boolean>(false);
  const ecgData = ref<ECGLead | null>(null);
  const hrvData = ref<HRVData | null>(null);
  const arrhythmiaEvents = ref<ArrhythmiaEvent[]>([]);
  const rhythmDiagnosis = ref<string>('');
  const isLoading = ref<boolean>(false);
  const useBackend = ref<boolean>(false);
  const backendUrl = ref<string>('http://localhost:8000');

  let animationTimer: ReturnType<typeof setInterval> | null = null;
  let scrollOffset = ref<number>(0);

  // Getters
  const currentSamples = computed(() => ecgData.value?.samples ?? []);
  const currentRPeaks = computed(() => ecgData.value?.rPeaks ?? []);
  const currentHeartRate = computed(() => hrvData.value?.heartRate ?? heartRate.value);

  // Actions

  /**
   * Generate realistic 12-lead ECG waveform data with PQRST morphology
   */
  function generateECGWaveform(): ECGLead {
    const totalSamples = Math.floor(duration.value * samplingRate.value);
    const samples: number[] = new Array(totalSamples);
    const config = LEAD_CONFIGS[selectedLead.value] || LEAD_CONFIGS['II'];
    const cycleDuration = 60.0 / heartRate.value;
    const samplesPerCycle = Math.floor(cycleDuration * samplingRate.value);

    for (let i = 0; i < totalSamples; i++) {
      const time = i / samplingRate.value;
      const cyclePosition = (time % cycleDuration) / cycleDuration;

      // Add slight HRV variation per beat
      const beatIndex = Math.floor(time / cycleDuration);
      const hrvFactor = 1.0 + Math.sin(beatIndex * 0.7) * 0.02;

      samples[i] = generatePQRSTCycle(cyclePosition, config) * hrvFactor;

      // Add baseline wander
      samples[i] += 0.03 * Math.sin(2 * Math.PI * 0.15 * time);
      // Add small noise
      samples[i] += (Math.random() - 0.5) * 0.02;
    }

    return {
      leadName: selectedLead.value,
      samplingRate: samplingRate.value,
      duration: duration.value,
      samples,
      rPeaks: [],
    };
  }

  /**
   * Pan-Tompkins R-peak detection algorithm
   * Simplified implementation: bandpass -> differentiate -> square -> integrate -> threshold
   */
  function detectRPeaks(samples: number[], sr: number): RPeak[] {
    const rPeaks: RPeak[] = [];
    const minDistance = Math.floor(0.2 * sr); // 200ms minimum between peaks

    // Simple moving average for baseline
    const windowSize = Math.floor(0.15 * sr);
    const threshold = samples.reduce((a, b) => a + b, 0) / samples.length;
    const stdDev = Math.sqrt(
      samples.reduce((sum, s) => sum + (s - threshold) ** 2, 0) / samples.length
    );
    const detectionThreshold = threshold + 0.5 * stdDev;

    let lastPeakIndex = -minDistance;

    for (let i = 1; i < samples.length - 1; i++) {
      if (
        samples[i] > detectionThreshold &&
        samples[i] > samples[i - 1] &&
        samples[i] > samples[i + 1] &&
        i - lastPeakIndex >= minDistance
      ) {
        // Find local maximum in a small window
        let maxVal = samples[i];
        let maxIdx = i;
        const searchRadius = Math.floor(0.01 * sr);
        for (let j = Math.max(0, i - searchRadius); j < Math.min(samples.length, i + searchRadius); j++) {
          if (samples[j] > maxVal) {
            maxVal = samples[j];
            maxIdx = j;
          }
        }

        rPeaks.push({
          index: maxIdx,
          time: maxIdx / sr,
          amplitude: maxVal,
        });
        lastPeakIndex = i;
      }
    }

    return rPeaks;
  }

  /**
   * Calculate HRV metrics from R-peak positions
   * SDNN, RMSSD, pNN50
   */
  function calculateHRV(rPeaks: RPeak[], sr: number): HRVData {
    if (rPeaks.length < 3) {
      return { heartRate: heartRate.value, sdnn: 0, rmssd: 0, pnn50: 0, nnIntervals: [] };
    }

    const nnIntervals: number[] = [];
    for (let i = 1; i < rPeaks.length; i++) {
      const rr = ((rPeaks[i].index - rPeaks[i - 1].index) / sr) * 1000;
      nnIntervals.push(rr);
    }

    const meanRR = nnIntervals.reduce((a, b) => a + b, 0) / nnIntervals.length;
    const hr = meanRR > 0 ? 60000 / meanRR : 0;

    // SDNN
    const variance = nnIntervals.reduce((sum, x) => sum + (x - meanRR) ** 2, 0) / nnIntervals.length;
    const sdnn = Math.sqrt(variance);

    // RMSSD
    let sumSquaredDiffs = 0;
    for (let i = 1; i < nnIntervals.length; i++) {
      sumSquaredDiffs += (nnIntervals[i] - nnIntervals[i - 1]) ** 2;
    }
    const rmssd = Math.sqrt(sumSquaredDiffs / (nnIntervals.length - 1));

    // pNN50
    let nn50Count = 0;
    for (let i = 1; i < nnIntervals.length; i++) {
      if (Math.abs(nnIntervals[i] - nnIntervals[i - 1]) > 50) {
        nn50Count++;
      }
    }
    const pnn50 = (nn50Count / (nnIntervals.length - 1)) * 100;

    return {
      heartRate: Math.round(hr * 10) / 10,
      sdnn: Math.round(sdnn * 100) / 100,
      rmssd: Math.round(rmssd * 100) / 100,
      pnn50: Math.round(pnn50 * 100) / 100,
      nnIntervals,
    };
  }

  /**
   * Arrhythmia detection: tachycardia, bradycardia, ST-elevation
   */
  function detectArrhythmias(hrv: HRVData, rPeaks: RPeak[], samples: number[], sr: number): ArrhythmiaEvent[] {
    const events: ArrhythmiaEvent[] = [];
    const hr = hrv.heartRate;

    if (hr > 100) {
      events.push({
        eventType: 'tachycardia',
        confidence: Math.min(1.0, (hr - 100) / 50 + 0.6),
        description: `心率过快 (${hr.toFixed(0)} BPM)，检测到心动过速`,
        timestamp: rPeaks[0]?.time ?? 0,
      });
    }

    if (hr < 60 && hr > 0) {
      events.push({
        eventType: 'bradycardia',
        confidence: Math.min(1.0, (60 - hr) / 30 + 0.6),
        description: `心率过慢 (${hr.toFixed(0)} BPM)，检测到心动过缓`,
        timestamp: rPeaks[0]?.time ?? 0,
      });
    }

    // ST-segment elevation detection
    let stElevationCount = 0;
    for (const rp of rPeaks) {
      const stStart = rp.index + Math.floor(0.08 * sr);
      const stEnd = rp.index + Math.floor(0.12 * sr);
      if (stEnd < samples.length) {
        const stLevel = samples.slice(stStart, stEnd).reduce((a, b) => a + b, 0) / (stEnd - stStart);
        const blStart = Math.max(0, rp.index - Math.floor(0.2 * sr));
        const baseline = samples.slice(blStart, rp.index).reduce((a, b) => a + b, 0) / (rp.index - blStart);
        if (stLevel - baseline > 0.1) {
          stElevationCount++;
        }
      }
    }
    if (stElevationCount > rPeaks.length * 0.5) {
      events.push({
        eventType: 'st_elevation',
        confidence: Math.min(1.0, stElevationCount / Math.max(1, rPeaks.length)),
        description: '检测到 ST 段抬高，可能提示心肌梗死',
        timestamp: rPeaks[0]?.time ?? 0,
      });
    }

    if (events.length === 0) {
      events.push({
        eventType: 'normal',
        confidence: 1.0,
        description: '正常窦性心律',
        timestamp: rPeaks[0]?.time ?? 0,
      });
    }

    return events;
  }

  /**
   * Run full ECG analysis (frontend simulation)
   */
  async function analyzeECG() {
    isLoading.value = true;

    if (useBackend.value) {
      // Use backend API
      try {
        const response = await fetch(`${backendUrl.value}/ecg/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_name: selectedLead.value,
            duration: duration.value,
            sampling_rate: samplingRate.value,
            heart_rate: heartRate.value,
          }),
        });
        const data: ECGAnalysisResponse = await response.json();
        ecgData.value = {
          leadName: data.lead.lead_name,
          samplingRate: data.lead.sampling_rate,
          duration: data.lead.duration,
          samples: data.lead.samples,
          rPeaks: data.lead.r_peaks.map((rp: any) => ({
            index: rp.index,
            time: rp.time,
            amplitude: rp.amplitude,
          })),
        };
        hrvData.value = {
          heartRate: data.hrv.heart_rate,
          sdnn: data.hrv.sdnn,
          rmssd: data.hrv.rmssd,
          pnn50: data.hrv.pnn50,
          nnIntervals: data.hrv.nn_intervals,
        };
        arrhythmiaEvents.value = data.arrhythmia_events.map((evt: any) => ({
          eventType: evt.event_type,
          confidence: evt.confidence,
          description: evt.description,
          timestamp: evt.timestamp,
        }));
        rhythmDiagnosis.value = data.rhythm_diagnosis;
      } catch (error) {
        console.error('Backend API error:', error);
        // Fallback to frontend simulation
        runFrontendAnalysis();
      }
    } else {
      runFrontendAnalysis();
    }

    isLoading.value = false;
  }

  function runFrontendAnalysis() {
    const lead = generateECGWaveform();
    const peaks = detectRPeaks(lead.samples, lead.samplingRate);
    lead.rPeaks = peaks;
    ecgData.value = lead;

    const hrv = calculateHRV(peaks, lead.samplingRate);
    hrvData.value = hrv;

    const events = detectArrhythmias(hrv, peaks, lead.samples, lead.samplingRate);
    arrhythmiaEvents.value = events;

    const isNormal = events.some(e => e.eventType === 'normal');
    rhythmDiagnosis.value = isNormal
      ? `正常窦性心律 | HR: ${hrv.heartRate.toFixed(0)} BPM | SDNN: ${hrv.sdnn.toFixed(1)} ms`
      : events.map(e => e.description).join(' | ');

    // 本次设置与全部结论、指标、波形作为同一条快照落盘（整屏均为本次结果）
    persistSnapshot({
      version: LOCAL_SNAPSHOT_VERSION,
      savedAt: Date.now(),
      selectedLead: selectedLead.value,
      heartRate: heartRate.value,
      duration: duration.value,
      samplingRate: samplingRate.value,
      ecgData: lead,
      hrvData: hrv,
      arrhythmiaEvents: events,
      rhythmDiagnosis: rhythmDiagnosis.value,
    });
  }

  /**
   * 恢复最近一次本地分析：导联、心率设置与结论一起还原，
   * 指标区（HRV）与事件区（心律失常）展示同一次数据。
   * 返回 true 表示已恢复；无记录或记录残缺时返回 false，由调用方走默认分析。
   */
  function restoreLastAnalysis(): boolean {
    const snapshot = loadSnapshot();
    if (!snapshot) return false;

    selectedLead.value = snapshot.selectedLead;
    heartRate.value = snapshot.heartRate;
    duration.value = snapshot.duration;
    samplingRate.value = snapshot.samplingRate;
    ecgData.value = snapshot.ecgData;
    hrvData.value = snapshot.hrvData;
    arrhythmiaEvents.value = snapshot.arrhythmiaEvents;
    rhythmDiagnosis.value = snapshot.rhythmDiagnosis;
    scrollOffset.value = 0;
    return true;
  }

  /**
   * Start real-time monitoring simulation
   */
  function startMonitoring() {
    isMonitoring.value = true;
    analyzeECG();
    animationTimer = setInterval(() => {
      scrollOffset.value += 5;
      // Regenerate data every full cycle
      if (scrollOffset.value >= currentSamples.value.length) {
        scrollOffset.value = 0;
        analyzeECG();
      }
    }, 50);
  }

  /**
   * Stop monitoring
   */
  function stopMonitoring() {
    isMonitoring.value = false;
    if (animationTimer) {
      clearInterval(animationTimer);
      animationTimer = null;
    }
  }

  /**
   * Select a different ECG lead
   */
  function selectLead(lead: string) {
    selectedLead.value = lead;
    if (isMonitoring.value) {
      analyzeECG();
    }
  }

  /**
   * Update heart rate setting
   */
  function setHeartRate(hr: number) {
    heartRate.value = hr;
    if (isMonitoring.value) {
      analyzeECG();
    }
  }

  return {
    // State
    selectedLead,
    heartRate,
    samplingRate,
    duration,
    isMonitoring,
    ecgData,
    hrvData,
    arrhythmiaEvents,
    rhythmDiagnosis,
    isLoading,
    useBackend,
    backendUrl,
    scrollOffset,
    // Getters
    currentSamples,
    currentRPeaks,
    currentHeartRate,
    // Actions
    analyzeECG,
    restoreLastAnalysis,
    startMonitoring,
    stopMonitoring,
    selectLead,
    setHeartRate,
    generateECGWaveform,
    detectRPeaks,
    calculateHRV,
    detectArrhythmias,
  };
});
