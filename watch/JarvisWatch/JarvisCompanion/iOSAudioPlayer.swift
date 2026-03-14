import AVFoundation

/// Queues and plays MP3 audio chunks received from the JARVIS server.
class iOSAudioPlayer: NSObject, AVAudioPlayerDelegate {
    static let shared = iOSAudioPlayer()

    private var queue: [Data] = []
    private var player: AVAudioPlayer?
    private var isPlaying = false

    private override init() {
        super.init()
        setupAudioSession()
        bindConnection()
    }

    private func setupAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch { }
    }

    private func bindConnection() {
        let conn = iOSConnectionManager.shared
        conn.onAudioReceived = { [weak self] data in
            self?.enqueue(data)
        }
        conn.onAudioEnd = { [weak self] in
            // All chunks sent — queue will drain naturally
            _ = self
        }
    }

    func enqueue(_ data: Data) {
        queue.append(data)
        if !isPlaying {
            playNext()
        }
    }

    func stop() {
        queue.removeAll()
        player?.stop()
        player = nil
        isPlaying = false
    }

    private func playNext() {
        guard !queue.isEmpty else {
            isPlaying = false
            return
        }

        let data = queue.removeFirst()
        do {
            player = try AVAudioPlayer(data: data)
            player?.delegate = self
            player?.play()
            isPlaying = true
        } catch {
            // Skip bad chunk, try next
            playNext()
        }
    }

    // AVAudioPlayerDelegate
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        playNext()
    }
}
