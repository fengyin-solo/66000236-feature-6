import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ECGLead, HRVData, RPeak, ArrhythmiaEvent, ECGAnalysisResponse, LocalAnalysisSnapshot } from '../types';
import { LEAD_NAMES } from '../types';

const LOCAL_SNAPSHOT_KEY = 'ecg:local-analysis:last';
const LOCAL_SNAPSHOT_VERSION = 1;

/**
 * 持久化最近一次本地分析的完整快照。
 * 设置（导联、心率）与结论（波形、指标、事件、诊断）一次性整体写入，
 * 避免新旧结论交错。localStorage 不可用时静默降级为仅内存态。
 */
function saveLocalSnapshot(snapshot: LocalAnalysisSnapshot): void {
  try {
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn('无法保存本地分析记录:', error);
  }
}

function clearLocalSnapshot(): void {
  try {
    localStorage.removeItem(LOCAL_SNAPSHOT_KEY);
  } catch {
    // localStorage 不可用，忽略
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRPeak(value: unknown): value is RPeak {
  if (typeof value !== 'object' || value === null) return false;
  const peak = value as Record<string, unknown>;
  return isFiniteNumber(peak.index) && isFiniteNumber(peak.time) && isFiniteNumber(peak.amplitude);
}

function isArrhythmiaEvent(value: unknown, validTypes: readonly string[]): value is ArrhythmiaEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.eventType === 'string' &&
    validTypes.includes(event.eventType) &&
    isFiniteNumber(event.confidence) &&
    typeof event.description === 'string' &&
    isFiniteNumber(event.timestamp)
  );
}

/**
 * 严格校验本地快照：记录不存在或任何字段残缺时一律视为无效，
 * 保证恢复后指标区与事件区展示的必然是同一次完整分析。
 */
function isValidSnapshot(value: unknown): value is LocalAnalysisSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Record<string, unknown>;

  if (snapshot.version !== LOCAL_SNAPSHOT_VERSION) return false;
  if (!isFiniteNumber(snapshot.savedAt)) return false;
  if (typeof snapshot.selectedLead !== 'string' || !LEAD_NAMES.includes(snapshot.selectedLead)) return false;
  if (!isFiniteNumber(snapshot.heartRate) || !isFiniteNumber(snapshot.samplingRate) || !isFiniteNumber(snapshot.duration)) return false;
  if (typeof snapshot.rhythmDiagnosis !== 'string' || snapshot.rhythmDiagnosis.length === 0) return false;

  const ecg = snapshot.ecgData as Record<string, unknown> | null;
  if (
    typeof ecg !== 'object' ||
    ecg === null ||
    typeof ecg.leadName !== 'string' ||
    ecg.leadName !== snapshot.selectedLead ||
    !isFiniteNumber(ecg.samplingRate) ||
    ecg.samplingRate !== snapshot.samplingRate ||
    !isFiniteNumber(ecg.duration) ||
    ecg.duration !== snapshot.duration ||
    !Array.isArray(ecg.samples) ||
    ecg.samples.length === 0 ||
    !ecg.samples.every(isFiniteNumber) ||
    !Array.isArray(ecg.rPeaks) ||
    !ecg.rPeaks.every(isRPeak)
  ) {
    return false;
  }

  // 采样点数需与时长、采样率匹配（容忍 1 个点的取整误差）
  const expectedSamples = Math.floor(ecg.duration * ecg.samplingRate);
  if (Math.abs(ecg.samples.length - expectedSamples) > 1) return false;

  const hrv = snapshot.hrvData as Record<string, unknown> | null;
  if (
    typeof hrv !== 'object' ||
    hrv === null ||
    !isFiniteNumber(hrv.heartRate) ||
    !isFiniteNumber(hrv.sdnn) ||
    !isFiniteNumber(hrv.rmssd) ||
    !isFiniteNumber(hrv.pnn50) ||
    !Array.isArray(hrv.nnIntervals) ||
    !hrv.nnIntervals.every(isFiniteNumber)
  ) {
    return false;
  }

  // 本地分析总会产出至少一个事件（含 normal），空数组属于残缺记录
  const eventTypes = ['normal', 'tachycardia', 'bradycardia', 'st_elevation', 'atrial_fibrillation', 'premature_ventricular_contraction'];
  return (
    Array.isArray(snapshot.arrhythmiaEvents) &&
    snapshot.arrhythmiaEvents.length > 0 &&
    snapshot.arrhythmiaEvents.every((event) => isArrhythmiaEvent(event, eventTypes))
  );
}

/**
 * 读取并校验最近一次本地分析快照；不存在或内容残缺时返回 null，
 * 残缺记录会被清除，避免反复尝试恢复坏数据。
 */
function loadLocalSnapshot(): LocalAnalysisSnapshot | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LOCAL_SNAPSHOT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearLocalSnapshot();
    return null;
  }

  if (!isValidSnapshot(parsed)) {
    clearLocalSnapshot();
    return null;
  }
  return parsed;
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
   * Pan-Tompkins 风格的 R 波检测
   * 简化实现：去除基线 -> 自适应阈值 -> 不应期抑制 -> 每拍取局部最高点。
   * 固定阈值会把 T 波误判成 R 波（心率被估成约 2 倍），因此按预期心动周期
   * 施加不应期，保证每个周期最多检出一个 R 峰。
   */
  function detectRPeaks(samples: number[], sr: number): RPeak[] {
    const rPeaks: RPeak[] = [];
    if (samples.length === 0) return rPeaks;

    // 去基线：滑动平均后的残差，凸显 R 峰、压低漂移与 T 波
    const windowSize = Math.max(1, Math.floor(0.15 * sr));
    let runningSum = 0;
    const baseline: number[] = new Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      runningSum += samples[i];
      if (i >= windowSize) runningSum -= samples[i - windowSize];
      baseline[i] = runningSum / Math.min(i + 1, windowSize);
    }
    const residual = samples.map((s, i) => s - baseline[i]);

    const mean = residual.reduce((a, b) => a + b, 0) / residual.length;
    const stdDev = Math.sqrt(
      residual.reduce((sum, s) => sum + (s - mean) ** 2, 0) / residual.length
    );
    // R 峰是最高的正向偏转，阈值取 1.2 倍标准差，低于原实现的 0.5 倍，
    // 配合不应期可避免 T 波越阈被误检
    const detectionThreshold = mean + 1.2 * stdDev;

    // 预期心动周期与不应期（按模拟心率估算，兼容低至 30 BPM）
    const expectedCycle = 60.0 / heartRate.value;
    const refractory = Math.floor(0.45 * expectedCycle * sr);
    const searchRadius = Math.floor(0.05 * sr);
    const candidates: number[] = [];

    let lastPeakIndex = -refractory;
    for (let i = 1; i < samples.length - 1; i++) {
      if (
        residual[i] > detectionThreshold &&
        residual[i] >= residual[i - 1] &&
        residual[i] >= residual[i + 1] &&
        i - lastPeakIndex >= refractory
      ) {
        // 在小窗口内确认真正的局部最大值
        let maxIdx = i;
        const lo = Math.max(1, i - searchRadius);
        const hi = Math.min(samples.length - 1, i + searchRadius);
        for (let j = lo; j <= hi; j++) {
          if (residual[j] > residual[maxIdx]) maxIdx = j;
        }
        candidates.push(maxIdx);
        lastPeakIndex = maxIdx;
        i = maxIdx;
      }
    }

    // 再按不应期去重，保留幅度更高的候选
    for (const idx of candidates) {
      const last = rPeaks[rPeaks.length - 1];
      if (last && idx - last.index < refractory) {
        if (residual[idx] > residual[last.index]) {
          last.index = idx;
          last.time = idx / sr;
          last.amplitude = samples[idx];
        }
      } else {
        rPeaks.push({ index: idx, time: idx / sr, amplitude: samples[idx] });
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

    // 整屏替换为本次结果，避免上一次的心率过快/过慢结论残留
    const events = detectArrhythmias(hrv, peaks, lead.samples, lead.samplingRate);
    arrhythmiaEvents.value = events;

    const isNormal = events.some(e => e.eventType === 'normal');
    rhythmDiagnosis.value = isNormal
      ? `正常窦性心律 | HR: ${hrv.heartRate.toFixed(0)} BPM | SDNN: ${hrv.sdnn.toFixed(1)} ms`
      : events.map(e => e.description).join(' | ');

    // 导联、心率设置与本次结论一起整体持久化
    saveLocalSnapshot({
      version: LOCAL_SNAPSHOT_VERSION,
      savedAt: Date.now(),
      selectedLead: selectedLead.value,
      heartRate: heartRate.value,
      samplingRate: samplingRate.value,
      duration: duration.value,
      ecgData: lead,
      hrvData: hrv,
      arrhythmiaEvents: events,
      rhythmDiagnosis: rhythmDiagnosis.value,
    });
  }

  /**
   * 恢复最近一次本地分析的完整快照（设置 + 波形 + 指标 + 事件 + 结论）。
   * 恢复成功返回 true；没有记录或记录残缺时返回 false，由调用方按空状态处理。
   */
  function restoreLocalSnapshot(): boolean {
    const snapshot = loadLocalSnapshot();
    if (!snapshot) return false;

    selectedLead.value = snapshot.selectedLead;
    heartRate.value = snapshot.heartRate;
    samplingRate.value = snapshot.samplingRate;
    duration.value = snapshot.duration;
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
    restoreLocalSnapshot,
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
