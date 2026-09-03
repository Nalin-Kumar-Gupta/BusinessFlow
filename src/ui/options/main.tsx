import { render } from 'preact';
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useState } from 'preact/hooks';
import { getSettings, resetSettings, saveSettings } from '../../storage/settings.js';
import { Modal } from '../dashboard/Modal.js';

function App(): JSX.Element {
  const [saved, setSaved] = useState(false);
  const [slaEnabled, setSlaEnabled] = useState(false);
  const [slaSec, setSlaSec] = useState(3);
  const [maxRunsPerTestCase, setMaxRunsPerTestCase] = useState(10);
  const [captureNetworkErrorBodies, setCaptureNetworkErrorBodies] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  useEffect(() => {
    void (async () => {
      const settings = await getSettings();
      setSlaEnabled(Boolean(settings.slaEnabled));
      setSlaSec(Math.min(20, Math.max(1, Math.round(settings.slaSec ?? 3))));
      setMaxRunsPerTestCase(Math.min(15, Math.max(2, Math.round(settings.maxRunsPerTestCase ?? 10))));
      setCaptureNetworkErrorBodies(Boolean(settings.captureNetworkErrorBodies));
    })();
  }, []);

  const markSaved = (): void => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const handleToggleSla = async (enabled: boolean): Promise<void> => {
    setSlaEnabled(enabled);
    await saveSettings({ slaEnabled: enabled });
    markSaved();
  };

  const handleSlaChange = async (next: number): Promise<void> => {
    setSlaSec(next);
    await saveSettings({ slaSec: next });
    markSaved();
  };

  const handleMaxRunsChange = async (next: number): Promise<void> => {
    setMaxRunsPerTestCase(next);
    await saveSettings({ maxRunsPerTestCase: next });
    markSaved();
  };

  const handleCaptureBodyToggle = async (enabled: boolean): Promise<void> => {
    setCaptureNetworkErrorBodies(enabled);
    await saveSettings({ captureNetworkErrorBodies: enabled });
    markSaved();
  };

  const handleReset = async (): Promise<void> => {
    setShowResetConfirm(false);
    await resetSettings();
    setSlaEnabled(false);
    setSlaSec(3);
    setMaxRunsPerTestCase(10);
    setCaptureNetworkErrorBodies(false);
    markSaved();
  };


  return (
    <div class="options-page card">
      <header class="options-header">
        <div>
          <h1>Settings</h1>
          <p>Configure recording behavior for consistent test execution.</p>
        </div>
        {saved && <span class="badge badge-success" role="status" aria-live="polite">Saved</span>}
      </header>



      <section class="card">
        <h2>Privacy</h2>
        <div class="privacy-banner card">
          <strong>Privacy note:</strong> BusinessFlow stores run data locally and does not auto-upload telemetry.
        </div>
        <p class="privacy-note">
          Screenshots, step metadata, console/network diagnostics, and exports are created on your machine. Sharing only happens when you explicitly export files.
        </p>
      </section>

      <section class="card">
        <h2>API SLA Monitoring</h2>
        <p class="privacy-note">
          SLA (Service Level Agreement) helps flag API calls that are too slow for a test case.
          Turn it on to mark calls that exceed your threshold.
        </p>

        <label htmlFor="sla-enabled" class="options-toggle-row">
          <input
            id="sla-enabled"
            type="checkbox"
            checked={slaEnabled}
            onChange={(event) => void handleToggleSla((event.target as HTMLInputElement).checked)}
          />
          <span>Enable SLA monitoring</span>
        </label>

        <div class={`options-slider-row ${slaEnabled ? '' : 'is-disabled'}`}>
          <label htmlFor="sla-seconds-slider" class="privacy-note options-slider-label">SLA threshold (seconds)</label>
          <input
            id="sla-seconds-slider"
            type="range"
            min={1}
            max={20}
            step={1}
            value={slaSec}
            disabled={!slaEnabled}
            onInput={(event) => void handleSlaChange(Number((event.target as HTMLInputElement).value))}
            class="options-slider"
          />
          <strong class="options-slider-value" aria-live="polite">{slaSec}s</strong>
        </div>
      </section>

      <section class="card">
        <h2>Run Retention</h2>
        <p class="privacy-note">
          Keep the latest runs per test case. When the limit is reached, starting a new retest removes the oldest run.
        </p>

        <div class="options-slider-row">
          <label htmlFor="max-runs-slider" class="privacy-note options-slider-label">Max runs per test case</label>
          <input
            id="max-runs-slider"
            type="range"
            min={2}
            max={15}
            step={1}
            value={maxRunsPerTestCase}
            onInput={(event) => void handleMaxRunsChange(Number((event.target as HTMLInputElement).value))}
            class="options-slider"
          />
          <strong class="options-slider-value" aria-live="polite">{maxRunsPerTestCase}</strong>
        </div>
      </section>

      <section class="card">
        <h2>Network Body Capture (Errors Only)</h2>
        <p class="privacy-note">
          When enabled, BusinessFlow stores request/response bodies only for failed requests (HTTP 4xx/5xx/0) to help debugging. Keep this off if payloads may contain sensitive data.
        </p>
        <label htmlFor="capture-error-bodies" class="options-toggle-row">
          <input
            id="capture-error-bodies"
            type="checkbox"
            checked={captureNetworkErrorBodies}
            onChange={(event) => void handleCaptureBodyToggle((event.target as HTMLInputElement).checked)}
          />
          <span>Capture network bodies for failed requests</span>
        </label>
      </section>

      <section class="card">
        <p class="privacy-note">Reset to defaults (SLA monitoring OFF, threshold 3s, run limit 10, network body capture OFF).</p>
        <button class="btn btn-outline" onClick={() => setShowResetConfirm(true)}>Reset to defaults</button>
      </section>

      <footer class="options-footer">BusinessFlow v0.1.0 · Privacy-first local QA recorder</footer>

      {showResetConfirm && (
        <Modal
          title="Reset settings to defaults?"
          body="This turns SLA monitoring off, resets the threshold to 3 seconds, resets the per-test-case run limit to 10, and turns off network body capture. Existing recorded runs are not deleted."
          isDanger
          onConfirm={() => void handleReset()}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root) render(<App />, root);
