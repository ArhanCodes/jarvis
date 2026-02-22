import { exec, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { run } from '../utils/shell.js';
import { fmt } from '../utils/formatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface VoiceInputProvider {
  isAvailable(): Promise<boolean>;
  listen(durationMs?: number): Promise<string>;
  startContinuous(onCommand: (text: string) => void): Promise<void>;
  stop(): void;
}

// ── Swift helper source for macOS Speech Recognition ──
const SWIFT_HELPER = `
import Foundation
import Speech

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: voice-helper <duration_seconds>\\n", stderr)
    exit(1)
}

let duration = Double(CommandLine.arguments[1]) ?? 5.0

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        fputs("Speech recognition not authorized. Enable in System Settings > Privacy > Speech Recognition.\\n", stderr)
        exit(1)
    }
}

let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
let audioEngine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = false

let inputNode = audioEngine.inputNode
let recordingFormat = inputNode.outputFormat(forBus: 0)
inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
    request.append(buffer)
}

audioEngine.prepare()
try audioEngine.start()

fputs("🎤 Listening...\\n", stderr)

var finalText = ""
let semaphore = DispatchSemaphore(value: 0)

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result, result.isFinal {
        finalText = result.bestTranscription.formattedString
        semaphore.signal()
    }
    if let error = error {
        fputs("Recognition error: \\(error.localizedDescription)\\n", stderr)
        semaphore.signal()
    }
}

DispatchQueue.global().asyncAfter(deadline: .now() + duration) {
    audioEngine.stop()
    inputNode.removeTap(onBus: 0)
    request.endAudio()
}

_ = semaphore.wait(timeout: .now() + duration + 2.0)
print(finalText)
exit(0)
`;

export class MacOSVoiceInput implements VoiceInputProvider {
  private helperPath: string;
  private continuousProcess: ChildProcess | null = null;
  private isListening = false;

  constructor() {
    const voiceDir = join(__dirname, '..', '..', '.voice');
    this.helperPath = join(voiceDir, 'voice-helper');
  }

  async isAvailable(): Promise<boolean> {
    // Check if we can compile or have the binary
    if (existsSync(this.helperPath)) return true;
    // Check if swiftc is available
    const result = await run('which swiftc');
    return result.exitCode === 0;
  }

  private async ensureHelper(): Promise<boolean> {
    if (existsSync(this.helperPath)) return true;

    const voiceDir = dirname(this.helperPath);
    if (!existsSync(voiceDir)) mkdirSync(voiceDir, { recursive: true });

    const swiftPath = join(voiceDir, 'voice-helper.swift');
    writeFileSync(swiftPath, SWIFT_HELPER);

    console.log(fmt.info('Compiling voice helper (one-time setup)...'));
    const result = await run(
      `swiftc -O "${swiftPath}" -o "${this.helperPath}" -framework Speech -framework AVFoundation`,
      { timeout: 60000 }
    );

    if (result.exitCode !== 0) {
      console.log(fmt.error(`Failed to compile voice helper: ${result.stderr}`));
      return false;
    }

    console.log(fmt.success('Voice helper compiled successfully!'));
    return true;
  }

  async listen(durationMs: number = 5000): Promise<string> {
    const ready = await this.ensureHelper();
    if (!ready) throw new Error('Voice helper not available');

    const durationSec = Math.ceil(durationMs / 1000);
    const result = await run(`"${this.helperPath}" ${durationSec}`, { timeout: durationMs + 5000 });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Voice recognition failed');
    }

    return result.stdout.trim();
  }

  async startContinuous(onCommand: (text: string) => void): Promise<void> {
    const ready = await this.ensureHelper();
    if (!ready) throw new Error('Voice helper not available');

    this.isListening = true;
    console.log(fmt.banner('\n  🎤 Voice mode activated — speak your commands!'));
    console.log(fmt.info('Say "stop listening" or press Ctrl+C to exit voice mode.\n'));

    const listenLoop = async () => {
      while (this.isListening) {
        try {
          const text = await this.listen(5000);
          if (!text) continue;

          const lower = text.toLowerCase().trim();
          if (lower === 'stop listening' || lower === 'stop' || lower === 'exit voice') {
            this.isListening = false;
            console.log(fmt.info('Voice mode deactivated.'));
            return;
          }

          console.log(fmt.dim(`  🗣  Heard: "${text}"`));
          onCommand(text);
        } catch {
          // Brief pause on error then retry
          await new Promise(r => setTimeout(r, 500));
        }
      }
    };

    listenLoop();
  }

  stop(): void {
    this.isListening = false;
    if (this.continuousProcess) {
      this.continuousProcess.kill();
      this.continuousProcess = null;
    }
  }
}

// ── Fallback: no-op ──
export class NoopVoiceInput implements VoiceInputProvider {
  async isAvailable(): Promise<boolean> { return false; }
  async listen(): Promise<string> {
    throw new Error('Voice input is not configured.');
  }
  async startContinuous(): Promise<void> {
    throw new Error('Voice input is not configured.');
  }
  stop(): void { /* noop */ }
}

// Create the appropriate provider
export function createVoiceInput(): VoiceInputProvider {
  if (process.platform === 'darwin') {
    return new MacOSVoiceInput();
  }
  return new NoopVoiceInput();
}

export const voiceInput = createVoiceInput();
