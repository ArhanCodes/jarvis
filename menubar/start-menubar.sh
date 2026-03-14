#!/bin/bash
# Launch JARVIS menubar app (compile if needed, then run in background)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$SCRIPT_DIR/jarvis-menubar"
SOURCE="$SCRIPT_DIR/JarvisMenubar.swift"

# Kill any existing instance
pkill -f jarvis-menubar 2>/dev/null

# Compile if binary doesn't exist or source is newer
if [ ! -f "$BINARY" ] || [ "$SOURCE" -nt "$BINARY" ]; then
    echo "Compiling JARVIS menubar..."
    swiftc -O "$SOURCE" -o "$BINARY" -framework Cocoa 2>&1
    if [ $? -ne 0 ]; then
        echo "Failed to compile menubar app"
        exit 1
    fi
    echo "Menubar compiled."
fi

# Launch in background
"$BINARY" &
disown
echo "JARVIS menubar is running."
