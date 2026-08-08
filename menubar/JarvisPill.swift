// ── JARVIS Pill — native macOS 26 "Liquid Glass" Spotlight-style launcher ──
//
// A separate glass search capsule + individual floating glass circle buttons,
// summoned with a global hotkey (default ⌥-Space). Type a query; the capsule
// expands into a streaming answer. Talks to JARVIS over the watch WebSocket
// (ws://127.0.0.1:5225):  send {type:command,text,noAudio:true} / recv tokens.
//
// Standalone — does not touch the existing menubar app. Build with start-pill.sh.

import Cocoa
import Carbon.HIToolbox

var gApp: AppDelegate?

// MARK: - WebSocket client (Foundation-native, no deps)

final class JarvisLink {
    private var task: URLSessionWebSocketTask?
    private let url = URL(string: "ws://127.0.0.1:5225")!
    private var reconnectWork: DispatchWorkItem?
    private var reconnectDelay: Double = 1.0   // backs off to 6s while the core is off
    private(set) var connected = false

    var onToken: ((String) -> Void)?
    var onStatus: ((String) -> Void)?
    var onConn: ((Bool) -> Void)?
    var onBuild: ((String, [String: Any]) -> Void)?   // buildStart / buildTool / buildToolErr / buildDone

    func connect() {
        task?.cancel(with: .goingAway, reason: nil)
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receive()
        ping()
    }

    private func setConnected(_ v: Bool) {
        if v { reconnectDelay = 1.0 }   // snappy again once the core is back
        if connected != v {
            connected = v
            DispatchQueue.main.async { self.onConn?(v) }
        }
    }

    private func scheduleReconnect() {
        setConnected(false)
        reconnectWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.connect() }
        reconnectWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + reconnectDelay, execute: w)
        reconnectDelay = min(reconnectDelay * 1.6, 6.0)
    }

    // Called when the user opens the pill — retry NOW instead of waiting out
    // the backoff, so "Turn on JARVIS" + ⌥-Space feels instant.
    func nudge() {
        guard !connected else { return }
        reconnectDelay = 1.0
        reconnectWork?.cancel()
        connect()
    }

    private func ping() {
        guard let t = task else { return }
        t.sendPing { [weak self] err in
            guard let self = self, t === self.task else { return }  // stale task — ignore
            if err != nil { self.scheduleReconnect(); return }       // dead socket → reconnect
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.ping() }
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure:
                self.scheduleReconnect()
            case .success(let message):
                self.setConnected(true)
                if case .string(let text) = message { self.handle(text) }
                self.receive()
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "token":
            if let t = obj["text"] as? String { DispatchQueue.main.async { self.onToken?(t) } }
        case "status":
            if let s = obj["state"] as? String { DispatchQueue.main.async { self.onStatus?(s) } }
        case "error":
            if let m = obj["message"] as? String { DispatchQueue.main.async { self.onToken?("\n⚠︎ \(m)") } }
        case "buildStart", "buildTool", "buildToolErr", "buildDone":
            DispatchQueue.main.async { self.onBuild?(type, obj) }
        default:
            break
        }
    }

    func send(_ query: String) {
        let payload: [String: Any] = ["type": "command", "text": query, "noAudio": true]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let str = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(str)) { _ in }
    }

    // Same as send() but asks the core to speak the reply aloud on this Mac
    // (playOnMac → the core's TTS, currently ElevenLabs flash).
    func sendSpoken(_ query: String) {
        let payload: [String: Any] = ["type": "command", "text": query, "noAudio": false, "playOnMac": true]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let str = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(str)) { _ in }
    }

    func sendVision(_ query: String, image: String, mediaType: String = "image/png") {
        let payload: [String: Any] = ["type": "vision", "text": query, "image": image, "mediaType": mediaType]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let str = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(str)) { _ in }
    }
}

// MARK: - Floating panel

final class PillPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// MARK: - Thinking indicator (animated three dots, iMessage-style)

final class ThinkingDots: NSView {
    private var dots: [CALayer] = []
    private var timer: Timer?
    private let dotD: CGFloat = 7
    private let gap: CGFloat = 6

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        for i in 0..<3 {
            let dot = CALayer()
            dot.backgroundColor = NSColor.secondaryLabelColor.cgColor
            dot.cornerRadius = dotD / 2
            dot.frame = CGRect(x: CGFloat(i) * (dotD + gap), y: 2.5, width: dotD, height: dotD)
            layer?.addSublayer(dot)
            dots.append(dot)
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    func start() {
        stop()
        var phase: CGFloat = 0
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            phase += 0.14
            for (i, dot) in self.dots.enumerated() {
                let a = 0.25 + 0.75 * (0.5 + 0.5 * sin(phase - CGFloat(i) * 0.7))
                dot.opacity = Float(a)
            }
        }
    }
    func stop() { timer?.invalidate(); timer = nil }
}

// Cream paper + faint grid, matching jarvis.arhan.dev's hero — used as the
// backdrop "stage" for recorded demos.
final class DemoStageView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor(red: 0.957, green: 0.937, blue: 0.902, alpha: 1).setFill()   // #F4EFE6
        bounds.fill()
        NSColor(red: 0, green: 0, blue: 0, alpha: 0.045).setStroke()
        let step: CGFloat = 72
        let path = NSBezierPath()
        path.lineWidth = 1
        var x: CGFloat = 0
        while x <= bounds.width { path.move(to: NSPoint(x: x, y: 0)); path.line(to: NSPoint(x: x, y: bounds.height)); x += step }
        var y: CGFloat = 0
        while y <= bounds.height { path.move(to: NSPoint(x: 0, y: y)); path.line(to: NSPoint(x: bounds.width, y: y)); y += step }
        path.stroke()
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    // Geometry
    private let MARGIN: CGFloat = 10
    private let CAPSULE_W: CGFloat = 430
    private let ROW_H: CGFloat = 56
    private let EXPANDED_SEARCH_H: CGFloat = 360
    private let CIRCLE_D: CGFloat = 50
    private let CIRCLE_GAP: CGFloat = 12
    private let CAPSULE_GAP: CGFloat = 16
    private var panelW: CGFloat = 0

    private var panel: PillPanel!
    private var container: NSView!
    private var searchGlass: NSGlassEffectView!
    private var searchHost: NSView!
    private var field: NSTextField!
    private var icon: NSImageView!
    private var modelLabel: NSTextField!   // dim active-model tag on the right
    private var speakerBtn: NSButton!      // toggle: read replies aloud
    private var speakReplies = UserDefaults.standard.bool(forKey: "jarvis.speakReplies")
    private var speakOnce = false          // mic queries always speak back, one-shot
    private var divider: NSBox!
    private var answerScroll: NSScrollView!
    private var answerView: NSTextView!
    private var searchHeight: NSLayoutConstraint!
    private var answerHeight: NSLayoutConstraint!
    private var askCircle: NSGlassEffectView!
    private var researchCircle: NSGlassEffectView!
    private var buildCircle: NSGlassEffectView!
    private var thinking: ThinkingDots!
    private var awaitingFirstToken = false
    private var scope: String? = nil
    private var pendingImage: String? = nil   // base64 PNG pasted with ⌘V
    // Query typed while the core is still booting — fired the moment we connect.
    private var pendingAction: (() -> Void)? = nil
    private var pendingDeadline = Date.distantPast

    private let link = JarvisLink()
    private var hotKeyRef: EventHotKeyRef?
    private var clickMonitor: Any?
    private var expanded = false
    private var streaming = false

    func applicationDidFinishLaunching(_ note: Notification) {
        gApp = self
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        registerHotKey()
        installPasteMonitor()
        link.onToken = { [weak self] t in self?.appendToken(t) }
        link.onStatus = { [weak self] s in self?.onStatus(s) }
        link.onConn = { [weak self] c in self?.onConn(c) }
        link.onBuild = { [weak self] kind, obj in self?.onBuildEvent(kind, obj) }
        link.connect()
        showPill()

        // Demo hook: `runDemo` types and submits a scripted sequence so the pill
        // can demo itself for screen recordings. Local-only trigger:
        //   DistributedNotificationCenter "com.arhancodes.jarvis.demo.pill"
        // Selector-based registration with .deliverImmediately — the block API
        // defers delivery while the app is inactive (which both delayed and
        // double-fired demos when another app was frontmost).
        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(demoNotification(_:)),
            name: NSNotification.Name("com.arhancodes.jarvis.demo.pill"),
            object: nil, suspensionBehavior: .deliverImmediately)
    }

    @objc private func demoNotification(_ note: Notification) {
        runDemo(commands: (note.object as? String) ?? "battery|what time is it")
    }

    // MARK: self-demo (for screen recordings)
    private var demoBackdrop: NSWindow?
    private var demoUntil = Date.distantPast   // double-trigger guard

    // Full-screen cream "stage" behind the pill so recordings don't expose
    // whatever windows happen to be open. Matches the website's paper + grid.
    private func showDemoBackdrop() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let w = NSWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        w.level = .floating                       // below the pill's .modalPanel, above normal windows
        w.isOpaque = true
        w.hasShadow = false
        w.ignoresMouseEvents = true
        w.collectionBehavior = [.canJoinAllSpaces, .stationary]
        let v = DemoStageView(frame: NSRect(origin: .zero, size: screen.frame.size))
        w.contentView = v
        w.orderFrontRegardless()
        demoBackdrop = w
    }

    private func hideDemoBackdrop() {
        demoBackdrop?.orderOut(nil)
        demoBackdrop = nil
    }

    private func runDemo(commands: String) {
        if Date() < demoUntil { return }   // a demo is already running — ignore re-delivery
        let cmds = commands.split(separator: "|").map(String.init)
        demoUntil = Date().addingTimeInterval(Double(cmds.count) * 7.0 + 12.0)
        showDemoBackdrop()
        // Park the cursor at the right edge, mid-height — off the Dock (tooltips)
        // and out of the cropped shot. CG coords: origin top-left.
        if let s = NSScreen.main {
            CGWarpMouseCursorPosition(CGPoint(x: s.frame.maxX - 2, y: s.frame.height * 0.55))
        }
        showPill()
        // Tuck the pill right under the menu bar so the recording is one compact
        // strip: menu bar + pill, nothing else. (Normal ⌥-Space opens re-center it.)
        if let s = NSScreen.main {
            let f = panel.frame
            panel.setFrameOrigin(NSPoint(x: f.origin.x, y: s.visibleFrame.maxY - f.height - 6))
        }
        var delay: Double = 1.2
        for cmd in cmds {
            let typeStart = delay
            for (i, _) in cmd.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + typeStart + Double(i) * 0.07) { [weak self] in
                    guard let self = self else { return }
                    self.field.stringValue = String(cmd.prefix(i + 1))
                    // Caret to the end — otherwise the text renders selected (blue).
                    self.field.currentEditor()?.selectedRange = NSRange(location: i + 1, length: 0)
                }
            }
            let submitAt = typeStart + Double(cmd.count) * 0.07 + 0.5
            DispatchQueue.main.asyncAfter(deadline: .now() + submitAt) { [weak self] in
                self?.submit()
                self?.field.stringValue = ""
            }
            delay = submitAt + 4.5   // let the answer stream before the next command
        }
        // Builds run for minutes and end via buildDone — leave the pill and stage
        // up; onBuildEvent tears the stage down when the build finishes.
        let hasBuild = cmds.contains { $0.lowercased().hasPrefix("build ") }
        if !hasBuild {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay + 1.5) { [weak self] in
                self?.hidePill()
            }
            // Keep the stage up well past the pill so the menubar segment plays on it.
            DispatchQueue.main.asyncAfter(deadline: .now() + delay + 13.0) { [weak self] in
                self?.hideDemoBackdrop()
            }
        }
    }

    // MARK: build UI
    private func buildPanel() {
        let circlesW = CIRCLE_D * 6 + CIRCLE_GAP * 5
        panelW = MARGIN + CAPSULE_W + CAPSULE_GAP + circlesW + MARGIN
        let collapsedPanelH = MARGIN * 2 + ROW_H

        let screen = NSScreen.main ?? NSScreen.screens[0]
        let sf = screen.frame
        panel = PillPanel(
            contentRect: NSRect(x: sf.midX - panelW / 2, y: sf.maxY - 220, width: panelW, height: collapsedPanelH),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        // No forced appearance — the glass + label colors adapt to the system
        // and the desktop behind, exactly like the native Spotlight.
        panel.isFloatingPanel = true
        panel.level = .modalPanel
        panel.isOpaque = false
        panel.backgroundColor = .clear           // transparent → glass pieces float separately
        panel.hasShadow = false                  // each glass piece casts its own shadow
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        container = NSView(frame: NSRect(x: 0, y: 0, width: panelW, height: collapsedPanelH))
        container.autoresizingMask = [.width, .height]
        panel.contentView = container

        // ── Search capsule (its own glass) ──
        searchGlass = NSGlassEffectView()
        searchGlass.translatesAutoresizingMaskIntoConstraints = false
        searchGlass.cornerRadius = ROW_H / 2
        searchHost = NSView()
        searchHost.translatesAutoresizingMaskIntoConstraints = false
        searchGlass.contentView = searchHost
        container.addSubview(searchGlass)

        icon = NSImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        if let img = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: "Search") {
            icon.image = img.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 16, weight: .medium))
        }
        icon.contentTintColor = .secondaryLabelColor
        searchHost.addSubview(icon)

        field = NSTextField()
        field.translatesAutoresizingMaskIntoConstraints = false
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = NSFont.systemFont(ofSize: 19, weight: .regular)
        field.textColor = .labelColor
        field.placeholderAttributedString = NSAttributedString(
            string: "Search",
            attributes: [.foregroundColor: NSColor.placeholderTextColor,
                         .font: NSFont.systemFont(ofSize: 19, weight: .regular)])
        field.delegate = self
        field.cell?.usesSingleLineMode = true
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        searchHost.addSubview(field)

        // Dim active-model tag, right-aligned in the search capsule.
        modelLabel = NSTextField(labelWithString: "")
        modelLabel.translatesAutoresizingMaskIntoConstraints = false
        modelLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        modelLabel.textColor = .tertiaryLabelColor
        modelLabel.alignment = .right
        modelLabel.toolTip = "Active model"
        modelLabel.setContentHuggingPriority(.required, for: .horizontal)
        modelLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        searchHost.addSubview(modelLabel)

        // Speaker toggle — read replies aloud (dim when off, accent when on).
        speakerBtn = NSButton()
        speakerBtn.translatesAutoresizingMaskIntoConstraints = false
        speakerBtn.isBordered = false
        speakerBtn.bezelStyle = .regularSquare
        speakerBtn.imagePosition = .imageOnly
        speakerBtn.target = self
        speakerBtn.action = #selector(toggleSpeak)
        speakerBtn.setContentHuggingPriority(.required, for: .horizontal)
        searchHost.addSubview(speakerBtn)
        updateSpeakerGlyph()

        divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        divider.isHidden = true
        searchHost.addSubview(divider)

        answerScroll = NSScrollView()
        answerScroll.translatesAutoresizingMaskIntoConstraints = false
        answerScroll.drawsBackground = false
        answerScroll.hasVerticalScroller = true
        answerScroll.borderType = .noBorder
        answerScroll.isHidden = true
        answerView = NSTextView()
        answerView.isEditable = false
        answerView.isSelectable = true
        answerView.drawsBackground = false
        answerView.textColor = .labelColor
        answerView.font = NSFont.systemFont(ofSize: 15)
        answerView.textContainerInset = NSSize(width: 6, height: 8)
        answerView.minSize = NSSize(width: 0, height: 0)
        answerView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        answerView.isVerticallyResizable = true
        answerView.isHorizontallyResizable = false
        answerView.autoresizingMask = [.width]
        answerView.textContainer?.widthTracksTextView = true
        answerScroll.documentView = answerView
        searchHost.addSubview(answerScroll)

        thinking = ThinkingDots(frame: .zero)
        thinking.translatesAutoresizingMaskIntoConstraints = false
        thinking.isHidden = true
        searchHost.addSubview(thinking)

        // ── Separate glass circle buttons ──
        askCircle = makeGlassCircle("apple.intelligence", key: "1", tip: "Ask JARVIS", action: #selector(tapAsk))
        let screenC = makeGlassCircle("eye.fill", key: "2", tip: "Read my screen", action: #selector(tapScreen))
        researchCircle = makeGlassCircle("globe", key: "3", tip: "Web research", action: #selector(tapResearch))
        let bodyC = makeGlassCircle("heart.fill", key: "4", tip: "WHOOP body status", action: #selector(tapBody))
        let voiceC = makeGlassCircle("mic.fill", key: "5", tip: "Speak to JARVIS", action: #selector(tapVoice))
        buildCircle = makeGlassCircle("hammer.fill", key: "6", tip: "Build a project (Fable)", action: #selector(tapBuild))
        let circles = NSStackView(views: [askCircle, screenC, researchCircle, bodyC, voiceC, buildCircle])
        circles.orientation = .horizontal
        circles.spacing = CIRCLE_GAP
        circles.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(circles)

        searchHeight = searchGlass.heightAnchor.constraint(equalToConstant: ROW_H)
        answerHeight = answerScroll.heightAnchor.constraint(equalToConstant: 0)

        NSLayoutConstraint.activate([
            searchGlass.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MARGIN),
            searchGlass.topAnchor.constraint(equalTo: container.topAnchor, constant: MARGIN),
            searchGlass.widthAnchor.constraint(equalToConstant: CAPSULE_W),
            searchHeight,

            circles.leadingAnchor.constraint(equalTo: searchGlass.trailingAnchor, constant: CAPSULE_GAP),
            circles.centerYAnchor.constraint(equalTo: container.topAnchor, constant: MARGIN + ROW_H / 2),

            icon.leadingAnchor.constraint(equalTo: searchHost.leadingAnchor, constant: 20),
            icon.topAnchor.constraint(equalTo: searchHost.topAnchor, constant: (ROW_H - 22) / 2),
            icon.widthAnchor.constraint(equalToConstant: 22),
            icon.heightAnchor.constraint(equalToConstant: 22),

            field.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
            field.trailingAnchor.constraint(equalTo: speakerBtn.leadingAnchor, constant: -10),
            field.centerYAnchor.constraint(equalTo: icon.centerYAnchor),

            speakerBtn.trailingAnchor.constraint(equalTo: modelLabel.leadingAnchor, constant: -10),
            speakerBtn.centerYAnchor.constraint(equalTo: icon.centerYAnchor),
            speakerBtn.widthAnchor.constraint(equalToConstant: 18),
            speakerBtn.heightAnchor.constraint(equalToConstant: 18),

            modelLabel.trailingAnchor.constraint(equalTo: searchHost.trailingAnchor, constant: -18),
            modelLabel.centerYAnchor.constraint(equalTo: icon.centerYAnchor),

            divider.leadingAnchor.constraint(equalTo: searchHost.leadingAnchor, constant: 18),
            divider.trailingAnchor.constraint(equalTo: searchHost.trailingAnchor, constant: -18),
            divider.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 14),

            answerScroll.leadingAnchor.constraint(equalTo: searchHost.leadingAnchor, constant: 16),
            answerScroll.trailingAnchor.constraint(equalTo: searchHost.trailingAnchor, constant: -16),
            answerScroll.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 8),
            answerHeight,

            thinking.leadingAnchor.constraint(equalTo: searchHost.leadingAnchor, constant: 24),
            thinking.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 18),
            thinking.widthAnchor.constraint(equalToConstant: 33),
            thinking.heightAnchor.constraint(equalToConstant: 12),
        ])
    }

    private func makeGlassCircle(_ symbol: String, key: String, tip: String, action: Selector) -> NSGlassEffectView {
        let g = NSGlassEffectView()
        g.translatesAutoresizingMaskIntoConstraints = false
        g.cornerRadius = CIRCLE_D / 2
        let b = NSButton()
        b.translatesAutoresizingMaskIntoConstraints = false
        b.isBordered = false
        b.bezelStyle = .regularSquare
        b.title = ""
        b.imagePosition = .imageOnly
        if let img = NSImage(systemSymbolName: symbol, accessibilityDescription: tip) {
            b.image = img.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 16, weight: .regular))
        }
        b.contentTintColor = .secondaryLabelColor
        b.target = self
        b.action = action
        b.keyEquivalent = key
        b.keyEquivalentModifierMask = .command
        b.toolTip = "\(tip) (⌘\(key))"
        g.contentView = b
        g.widthAnchor.constraint(equalToConstant: CIRCLE_D).isActive = true
        g.heightAnchor.constraint(equalToConstant: CIRCLE_D).isActive = true
        return g
    }

    // MARK: hotkey (⌥-Space)
    private func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { (_, _, _) -> OSStatus in
            DispatchQueue.main.async { gApp?.togglePill() }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x4A505431), id: 1)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    // MARK: show / hide
    func togglePill() { panel.isVisible ? hidePill() : showPill() }

    func showPill() {
        collapse()
        link.nudge()   // if disconnected, retry immediately rather than waiting out the backoff
        refreshModelLabel()
        positionTopCenter()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        installClickMonitor()
    }

    // Read the active model the core reports in its status file and show a short
    // tag (e.g. "haiku 4.5") on the right of the search bar.
    private func refreshModelLabel() {
        guard let data = FileManager.default.contents(atPath: "/tmp/jarvis-status.json"),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let model = obj["model"] as? String, !model.isEmpty else {
            modelLabel.stringValue = ""
            return
        }
        // "claude-haiku-4-5" -> "haiku 4.5", "claude-fable-5" -> "fable 5"
        let raw = model.replacingOccurrences(of: "claude-", with: "")
        if let dash = raw.firstIndex(of: "-") {
            let name = String(raw[..<dash])
            let version = raw[raw.index(after: dash)...].replacingOccurrences(of: "-", with: ".")
            modelLabel.stringValue = "\(name) \(version)"
        } else {
            modelLabel.stringValue = raw
        }
    }

    func hidePill() {
        removeClickMonitor()
        panel.orderOut(nil)
        field.stringValue = ""
        collapse()
    }

    private func positionTopCenter() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let sf = screen.frame
        let h = panel.frame.height
        panel.setFrame(NSRect(x: sf.midX - panelW / 2, y: sf.maxY - 220 - (h - (MARGIN * 2 + ROW_H)),
                              width: panelW, height: h), display: true)
    }

    private func installClickMonitor() {
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.hidePill()
        }
    }
    private func removeClickMonitor() {
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
    }

    // MARK: expand / collapse  (only the search capsule grows; circles stay put)
    private func expand() {
        guard !expanded else { return }
        expanded = true
        divider.isHidden = false
        answerScroll.isHidden = false
        answerHeight.constant = EXPANDED_SEARCH_H - ROW_H - 28
        setSearchHeight(EXPANDED_SEARCH_H, animate: true)
    }
    private func collapse() {
        expanded = false
        stopThinking()
        pendingAction = nil
        if buildMode { buildMode = false; refreshModelLabel() }
        clearPendingImage()
        divider.isHidden = true
        answerScroll.isHidden = true
        answerView.string = ""
        answerHeight.constant = 0
        setSearchHeight(ROW_H, animate: false)
    }
    private func setSearchHeight(_ h: CGFloat, animate: Bool) {
        searchHeight.constant = h
        let panelH = MARGIN * 2 + h
        let f = panel.frame
        let newFrame = NSRect(x: f.minX, y: f.maxY - panelH, width: panelW, height: panelH)
        if animate {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.2
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrame(newFrame, display: true)
                container.layoutSubtreeIfNeeded()
            }
        } else {
            panel.setFrame(newFrame, display: true)
        }
    }

    // MARK: quick-action buttons
    @objc private func tapAsk() { toggleScope("ask") }
    @objc private func tapResearch() { toggleScope("research") }
    @objc private func tapScreen() { runInstant("what's on my screen") }
    @objc private func tapBody() { runInstant("how's my body") }
    @objc private func tapVoice() { startVoiceCapture() }
    @objc private func tapBuild() {
        toggleScope("build")
        // Nudge the placeholder so it's obvious what typing here will do now.
        setPlaceholder(scope == "build" ? "Describe a project to build…" : "Search")
    }

    private func toggleScope(_ s: String) {
        scope = (scope == s) ? nil : s
        let on = NSColor(white: 1, alpha: 0.22)
        askCircle.tintColor = scope == "ask" ? on : nil
        researchCircle.tintColor = scope == "research" ? on : nil
        buildCircle.tintColor = scope == "build" ? on : nil
        panel.makeFirstResponder(field)
    }

    private func startThinking() {
        awaitingFirstToken = true
        answerView.string = ""
        thinking.isHidden = false
        thinking.start()
    }
    private func stopThinking() {
        awaitingFirstToken = false
        thinking.stop()
        thinking.isHidden = true
    }

    private func runInstant(_ command: String) {
        expand()
        answerView.string = ""
        fireOrQueue { [weak self] in self?.deliver(command) }
    }

    // Run the send now if connected; otherwise queue it and fire the moment the
    // socket comes up (the core takes ~10s to boot after "Turn on JARVIS").
    private func fireOrQueue(_ send: @escaping () -> Void) {
        if link.connected {
            streaming = true
            startThinking()
            send()
            return
        }
        streaming = true
        startThinking()
        answerView.string = "Waiting for JARVIS to come online… (if it’s off, click the waveform in the menu bar → Turn on JARVIS)"
        pendingAction = { [weak self] in
            guard let self = self else { return }
            self.answerView.string = ""
            self.streaming = true
            self.startThinking()
            send()
        }
        pendingDeadline = Date().addingTimeInterval(30)
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self = self, self.pendingAction != nil, Date() >= self.pendingDeadline else { return }
            self.pendingAction = nil
            self.stopThinking()
            self.answerView.string = "JARVIS didn’t come online. Click the waveform icon in the menu bar and choose “Turn on JARVIS”, then try again."
        }
    }

    private func startVoiceCapture() {
        let exeDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        let helper = exeDir.deletingLastPathComponent().appendingPathComponent(".voice/voice-helper")
        guard FileManager.default.fileExists(atPath: helper.path) else {
            expand(); answerView.string = "Voice helper isn’t built yet — use JARVIS voice once (say “voice on”), then try the mic."
            return
        }
        field.stringValue = ""
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = helper
            p.arguments = ["4"]
            let pipe = Pipe()
            p.standardOutput = pipe
            try? p.run()
            p.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            DispatchQueue.main.async {
                // Voice in → voice out: a mic query always speaks its reply back.
                if !text.isEmpty { self.speakOnce = true; self.field.stringValue = text; self.submit() }
            }
        }
    }

    // MARK: paste-an-image
    private func installPasteMonitor() {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, self.panel.isKeyWindow else { return event }
            if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "v",
               let b64 = self.grabClipboardImage() {
                self.pendingImage = b64
                self.setSearchSymbol("photo.fill")
                self.setPlaceholder("Ask about the image, or press Enter")
                return nil   // consume — don't dump image bytes into the text field
            }
            return event
        }
    }

    private func grabClipboardImage() -> String? {
        let pb = NSPasteboard.general
        guard let imgs = pb.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage],
              let img = imgs.first else { return nil }
        return pngBase64(downscale(img, maxDim: 1568))
    }

    private func downscale(_ image: NSImage, maxDim: CGFloat) -> NSImage {
        let s = image.size
        let scale = min(1, maxDim / max(s.width, s.height))
        if scale >= 1 { return image }
        let newSize = NSSize(width: s.width * scale, height: s.height * scale)
        let out = NSImage(size: newSize)
        out.lockFocus()
        image.draw(in: NSRect(origin: .zero, size: newSize),
                   from: NSRect(origin: .zero, size: s), operation: .copy, fraction: 1)
        out.unlockFocus()
        return out
    }

    private func pngBase64(_ image: NSImage) -> String? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return png.base64EncodedString()
    }

    private func setSearchSymbol(_ symbol: String) {
        let cfg = NSImage.SymbolConfiguration(pointSize: 16, weight: .medium)
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
    }

    private func setPlaceholder(_ text: String) {
        field.placeholderAttributedString = NSAttributedString(
            string: text,
            attributes: [.foregroundColor: NSColor.placeholderTextColor,
                         .font: NSFont.systemFont(ofSize: 19, weight: .regular)])
    }

    private func clearPendingImage() {
        pendingImage = nil
        setSearchSymbol("magnifyingglass")
        setPlaceholder("Search")
    }

    // MARK: submit + stream
    private func submit() {
        var q = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)

        // Pasted image → vision (a question is optional).
        if let img = pendingImage {
            clearPendingImage()
            field.stringValue = ""
            expand()
            answerView.string = ""
            fireOrQueue { [weak self] in self?.link.sendVision(q, image: img) }
            return
        }

        guard !q.isEmpty else { return }
        if scope == "ask" { q = "ask \(q)" }
        else if scope == "research" { q = "research \(q)" }
        else if scope == "build" { q = "build \(q)" }
        scope = nil
        askCircle.tintColor = nil
        researchCircle.tintColor = nil
        buildCircle.tintColor = nil
        setPlaceholder("Search")
        expand()
        answerView.string = ""
        fireOrQueue { [weak self] in self?.deliver(q) }
    }

    private var buildMode = false

    private func appendToken(_ t: String) {
        if awaitingFirstToken { stopThinking() }   // first token in → drop the dots
        answerView.textStorage?.append(NSAttributedString(
            string: t,
            attributes: buildMode
                ? [.foregroundColor: NSColor.labelColor,
                   .font: NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)]
                : [.foregroundColor: NSColor.labelColor,
                   .font: NSFont.systemFont(ofSize: 15)]))
        answerView.scrollToEndOfDocument(nil)
    }

    // MARK: build transcript (Claude Code feel: mono, ⏺ tool lines, footer)
    private func appendBuild(_ text: String, color: NSColor, weight: NSFont.Weight = .regular) {
        if awaitingFirstToken { stopThinking() }
        answerView.textStorage?.append(NSAttributedString(
            string: text,
            attributes: [.foregroundColor: color,
                         .font: NSFont.monospacedSystemFont(ofSize: 12.5, weight: weight)]))
        answerView.scrollToEndOfDocument(nil)
    }

    private func onBuildEvent(_ kind: String, _ obj: [String: Any]) {
        switch kind {
        case "buildStart":
            buildMode = true
            expand()
            answerView.string = ""
            modelLabel.stringValue = (obj["model"] as? String) ?? "fable 5"
            let task = (obj["task"] as? String) ?? ""
            appendBuild("⏺ build · \(modelLabel.stringValue)\n", color: .secondaryLabelColor, weight: .semibold)
            appendBuild("  \(task)\n\n", color: .tertiaryLabelColor)
            startThinking()
        case "buildTool":
            appendBuild("⏺ \(( obj["text"] as? String) ?? "")\n", color: .secondaryLabelColor)
        case "buildToolErr":
            appendBuild("⏺ \(( obj["text"] as? String) ?? "")\n", color: .systemRed)
        case "buildDone":
            stopThinking()
            streaming = false
            if (obj["ok"] as? Bool) == true {
                let steps = (obj["steps"] as? Int).map(String.init) ?? "?"
                let dir = (obj["dir"] as? String) ?? ""
                appendBuild("\n✔ done · \(steps) steps\n", color: .labelColor, weight: .semibold)
                appendBuild("  \(dir)\n", color: .secondaryLabelColor)
            } else {
                let err = (obj["error"] as? String) ?? "build did not finish"
                appendBuild("\n✖ \(err)\n", color: .systemRed, weight: .semibold)
            }
            buildMode = false
            refreshModelLabel()   // restore the conversation model tag
            hideDemoBackdrop()    // demo stage (if any) comes down with the build
        default:
            break
        }
    }

    private func onStatus(_ s: String) {
        switch s {
        case "idle": streaming = false; stopThinking(); refreshModelLabel()   // catch a "set model …" switch
        default: break
        }
    }

    // MARK: speak replies
    @objc private func toggleSpeak() {
        speakReplies.toggle()
        UserDefaults.standard.set(speakReplies, forKey: "jarvis.speakReplies")
        updateSpeakerGlyph()
        panel.makeFirstResponder(field)
    }

    private func updateSpeakerGlyph() {
        let name = speakReplies ? "speaker.wave.2.fill" : "speaker.slash.fill"
        let cfg = NSImage.SymbolConfiguration(pointSize: 12, weight: .regular)
        speakerBtn.image = NSImage(systemSymbolName: name, accessibilityDescription: "Speak replies")?
            .withSymbolConfiguration(cfg)
        speakerBtn.contentTintColor = speakReplies ? .controlAccentColor : .tertiaryLabelColor
        speakerBtn.toolTip = speakReplies ? "Speaking replies aloud (click to mute)" : "Replies are silent (click to speak aloud)"
    }

    // Send a command, spoken aloud when the toggle is on or a mic query is in flight.
    private func deliver(_ q: String) {
        if speakReplies || speakOnce { speakOnce = false; link.sendSpoken(q) }
        else { link.send(q) }
    }

    private func onConn(_ c: Bool) {
        icon.contentTintColor = c ? .secondaryLabelColor : .tertiaryLabelColor
        if c { refreshModelLabel() }
        // Core just came online — fire the query the user typed while it was booting.
        if c, let go = pendingAction, Date() < pendingDeadline {
            pendingAction = nil
            go()
        }
    }

    // MARK: NSTextFieldDelegate
    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { submit(); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { hidePill(); return true }
        return false
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
