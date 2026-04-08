#!/usr/bin/env python3
"""
Double-Clap Daemon — listens for two sharp claps and launches Claude + JARVIS.
Runs as a macOS LaunchAgent so it's always on when the Mac is on.
"""

import subprocess
import time
import numpy as np
import sounddevice as sd

# --- Config ---
SAMPLE_RATE = 44100
BLOCK_SIZE = 1024
CLAP_THRESHOLD = 0.4        # amplitude spike to count as a clap (0-1 range)
CLAP_MIN_GAP = 0.08         # min seconds between two claps
CLAP_MAX_GAP = 0.5          # max seconds between two claps
COOLDOWN = 3.0              # seconds to ignore after a trigger
SILENCE_AFTER_CLAP = 0.03   # ignore samples right after a clap (echo)

# --- State ---
last_clap_time = 0.0
last_trigger_time = 0.0
clap_count = 0


def trigger():
    """Open Claude and start JARVIS."""
    global last_trigger_time
    last_trigger_time = time.time()
    print(f"[{time.strftime('%H:%M:%S')}] DOUBLE CLAP — launching Claude + JARVIS")

    # Open Claude app
    subprocess.Popen(["open", "-a", "Claude"])

    # Launch JARVIS in a new Terminal tab
    subprocess.Popen([
        "osascript", "-e",
        'tell application "Terminal" to do script "cd ~/Downloads/jarvis && npm run dev"'
    ])


def audio_callback(indata, frames, time_info, status):
    global last_clap_time, last_trigger_time, clap_count

    now = time.time()

    # Skip during cooldown
    if now - last_trigger_time < COOLDOWN:
        return

    # Peak amplitude of this block
    peak = np.max(np.abs(indata))

    if peak >= CLAP_THRESHOLD:
        gap = now - last_clap_time

        # Ignore echo / reverb from the same clap
        if gap < SILENCE_AFTER_CLAP:
            return

        if gap <= CLAP_MAX_GAP and gap >= CLAP_MIN_GAP:
            clap_count += 1
            if clap_count >= 1:  # first clap already counted, this is the second
                trigger()
                clap_count = 0
                return
        else:
            # First clap or too long since last — reset
            clap_count = 0

        last_clap_time = now


def main():
    print("Double-Clap Daemon started")
    print(f"  Threshold: {CLAP_THRESHOLD} | Gap: {CLAP_MIN_GAP}-{CLAP_MAX_GAP}s | Cooldown: {COOLDOWN}s")
    print("  Listening for double claps...")

    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        blocksize=BLOCK_SIZE,
        channels=1,
        callback=audio_callback,
    ):
        while True:
            time.sleep(1)


if __name__ == "__main__":
    main()
