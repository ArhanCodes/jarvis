import SwiftUI

/// Fullscreen JARVIS energy orb — ported from the macOS menubar EnergyOrbView.
/// Gold organic rings, energy filaments, dense particle cloud, glowing core.
struct EnergyOrbView: View {
    var currentState: String
    var isRecording: Bool

    @State private var time: CGFloat = 0
    @State private var particles: [OrbParticle] = []
    @State private var filaments: [Filament] = []
    @State private var initialized = false

    struct OrbParticle {
        var angle: CGFloat
        var elevation: CGFloat
        var radius: CGFloat
        var speed: CGFloat
        var size: CGFloat
        var alpha: CGFloat
    }

    struct Filament {
        var angle: CGFloat
        var length: CGFloat
        var speed: CGFloat
        var wobbleFreq: CGFloat
        var wobbleAmp: CGFloat
        var thickness: CGFloat
    }

    struct EnergyRing {
        var baseRadius: CGFloat
        var thickness: CGFloat
        var speed: CGFloat
        var segments: Int
        var alpha: CGFloat
    }

    let rings: [EnergyRing] = [
        EnergyRing(baseRadius: 0.92, thickness: 2.5, speed: 0.15, segments: 120, alpha: 0.7),
        EnergyRing(baseRadius: 0.78, thickness: 2.0, speed: -0.22, segments: 100, alpha: 0.55),
        EnergyRing(baseRadius: 0.62, thickness: 1.8, speed: 0.30, segments: 90, alpha: 0.45),
        EnergyRing(baseRadius: 0.45, thickness: 1.5, speed: -0.18, segments: 80, alpha: 0.35),
        EnergyRing(baseRadius: 0.30, thickness: 1.2, speed: 0.25, segments: 60, alpha: 0.3),
    ]

    private var effectiveState: String {
        isRecording ? "activated" : currentState
    }

    private var animSpeed: CGFloat {
        switch effectiveState {
        case "activated":  return 3.0
        case "processing": return 2.2
        case "speaking":   return 1.8
        case "idle":       return 0.3
        default:           return 0.08
        }
    }

    private var brightness: CGFloat {
        switch effectiveState {
        case "offline":    return 0.06
        case "idle":       return 0.2
        case "activated":  return 0.9
        case "processing": return 0.75
        case "speaking":   return 0.8
        default:           return 0.06
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            Canvas { context, size in
                let dt: CGFloat = 1.0 / 30.0
                let spd = animSpeed

                let W = size.width
                let H = size.height
                let cx = W / 2
                let cy = H / 2
                let orbR = min(W, H) * 0.28
                let breathe = sin(time * 0.8) * 0.03
                let dynamicR = orbR * (1.0 + breathe)
                let br = brightness

                // ── Energy filaments ──
                for f in filaments {
                    let wobble = sin(time * f.wobbleFreq + f.angle * 3.0) * f.wobbleAmp
                    let angle = f.angle + wobble
                    let fromR = dynamicR * 0.15
                    let toR = dynamicR * (0.6 + f.length * 0.8)
                    let a = br * 0.2 * (0.3 + f.length * 0.7)

                    var path = Path()
                    path.move(to: CGPoint(x: cx + cos(angle) * fromR, y: cy + sin(angle) * fromR))
                    path.addLine(to: CGPoint(x: cx + cos(angle) * toR, y: cy + sin(angle) * toR))
                    context.stroke(path, with: .color(Color(red: 1.0, green: 0.7, blue: 0.2).opacity(a)), lineWidth: f.thickness)
                }

                // ── Distorted energy rings ──
                for ring in rings {
                    let ringR = dynamicR * ring.baseRadius
                    let ringAlpha = br * ring.alpha
                    let ringTime = time * ring.speed

                    var path = Path()
                    let segCount = ring.segments
                    for s in 0..<segCount {
                        let angle = CGFloat(s) * (.pi * 2 / CGFloat(segCount)) + ringTime
                        let nextAngle = CGFloat(s + 1) * (.pi * 2 / CGFloat(segCount)) + ringTime

                        let noise1 = sin(angle * 3.0 + time * 2.0) * 0.04 + sin(angle * 7.0 - time * 3.5) * 0.025
                        let noise2 = sin(nextAngle * 3.0 + time * 2.0) * 0.04 + sin(nextAngle * 7.0 - time * 3.5) * 0.025

                        let r1 = ringR * (1.0 + noise1)
                        let r2 = ringR * (1.0 + noise2)

                        path.move(to: CGPoint(x: cx + cos(angle) * r1, y: cy + sin(angle) * r1))
                        path.addLine(to: CGPoint(x: cx + cos(nextAngle) * r2, y: cy + sin(nextAngle) * r2))
                    }
                    context.stroke(path, with: .color(Color(red: 1.0, green: 0.72, blue: 0.22).opacity(ringAlpha)), lineWidth: ring.thickness)
                }

                // ── Particles ──
                for p in particles {
                    let r = dynamicR * p.radius
                    let projR = r * cos(p.elevation)
                    let x = cx + cos(p.angle) * projR
                    let y = cy + sin(p.angle) * projR + sin(p.elevation) * r * 0.3
                    let depthFade = (1.0 + cos(p.elevation)) / 2.0
                    let a = br * p.alpha * depthFade
                    let sz = p.size * (0.8 + 0.4 * depthFade)

                    let rect = CGRect(x: x - sz / 2, y: y - sz / 2, width: sz, height: sz)
                    context.fill(Ellipse().path(in: rect), with: .color(Color(red: 1.0, green: 0.85, blue: 0.4).opacity(a)))
                }

                // ── Core glow ──
                let coreR = dynamicR * 0.35
                let coreSteps = 20
                for i in (0..<coreSteps).reversed() {
                    let frac = CGFloat(i) / CGFloat(coreSteps)
                    let r = coreR * frac
                    let a: CGFloat
                    if frac < 0.1 {
                        a = min(1.0, br * 1.8)
                    } else if frac < 0.3 {
                        a = br * 1.2 * (1.0 - (frac - 0.1) / 0.2)
                    } else {
                        a = br * 0.5 * (1.0 - frac) / 0.7
                    }
                    let rect = CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)
                    context.fill(Ellipse().path(in: rect), with: .color(Color(red: 1.0, green: 0.9, blue: 0.55).opacity(a)))
                }

                // ── Bright center dot ──
                let dotR = dynamicR * 0.04
                let dotRect = CGRect(x: cx - dotR, y: cy - dotR, width: dotR * 2, height: dotR * 2)
                context.fill(Ellipse().path(in: dotRect), with: .color(Color(red: 1.0, green: 0.98, blue: 0.9).opacity(min(1.0, br * 2.0))))

                // ── Update animation state ──
                DispatchQueue.main.async {
                    time += dt * spd
                    for i in 0..<particles.count {
                        particles[i].angle += dt * particles[i].speed * spd * 0.4
                    }
                    for i in 0..<filaments.count {
                        filaments[i].angle += dt * filaments[i].speed * spd
                    }
                }
            }
        }
        .background(Color.black)
        .ignoresSafeArea()
        .onAppear {
            guard !initialized else { return }
            initialized = true

            // Generate particles
            for _ in 0..<150 {
                particles.append(OrbParticle(
                    angle: .random(in: 0...(.pi * 2)),
                    elevation: .random(in: -(.pi / 2)...(.pi / 2)),
                    radius: .random(in: 0.08...1.0),
                    speed: .random(in: 0.1...1.8),
                    size: .random(in: 1.0...4.0),
                    alpha: .random(in: 0.15...0.9)
                ))
            }

            // Generate filaments
            for _ in 0..<30 {
                filaments.append(Filament(
                    angle: .random(in: 0...(.pi * 2)),
                    length: .random(in: 0.3...1.0),
                    speed: .random(in: 0.05...0.5),
                    wobbleFreq: .random(in: 1.0...4.0),
                    wobbleAmp: .random(in: 0.02...0.12),
                    thickness: .random(in: 0.5...2.5)
                ))
            }
        }
    }
}
