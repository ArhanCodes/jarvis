import SwiftUI

/// Simplified Arc Reactor visualization for Apple Watch.
/// Fewer particles and tendrils than the macOS version for watch GPU performance.
struct ArcReactorWatchView: View {
    let state: String
    let size: CGFloat

    @State private var rotation: Double = 0
    @State private var pulsePhase: Double = 0

    private var coreColor: Color {
        switch state {
        case "activated", "processing": return Color(red: 1.0, green: 0.82, blue: 0.3)  // Bright gold
        case "speaking": return Color(red: 1.0, green: 0.72, blue: 0.22) // Gold
        case "idle": return Color(red: 0.8, green: 0.58, blue: 0.15) // Dim gold
        default: return Color(red: 0.4, green: 0.3, blue: 0.1) // Very dim gold
        }
    }

    private var glowIntensity: Double {
        switch state {
        case "activated": return 0.9
        case "processing": return 0.8 + sin(pulsePhase * 4) * 0.15
        case "speaking": return 0.7 + sin(pulsePhase * 2) * 0.1
        case "idle": return 0.4 + sin(pulsePhase) * 0.1
        default: return 0.15
        }
    }

    private var rotationSpeed: Double {
        switch state {
        case "activated", "processing": return 2.5
        case "speaking": return 1.5
        case "idle": return 0.4
        default: return 0.1
        }
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, canvasSize in
                let now = timeline.date.timeIntervalSinceReferenceDate
                let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
                let radius = size / 2

                // Outer glow
                let outerGlow = coreColor.opacity(glowIntensity * 0.3)
                context.fill(
                    Path(ellipseIn: CGRect(
                        x: center.x - radius * 1.3,
                        y: center.y - radius * 1.3,
                        width: radius * 2.6,
                        height: radius * 2.6
                    )),
                    with: .radialGradient(
                        Gradient(colors: [outerGlow, .clear]),
                        center: center,
                        startRadius: radius * 0.3,
                        endRadius: radius * 1.3
                    )
                )

                // Core circle
                let coreGradient = Gradient(colors: [
                    coreColor.opacity(glowIntensity),
                    coreColor.opacity(glowIntensity * 0.6),
                    coreColor.opacity(glowIntensity * 0.2),
                ])
                context.fill(
                    Path(ellipseIn: CGRect(
                        x: center.x - radius * 0.35,
                        y: center.y - radius * 0.35,
                        width: radius * 0.7,
                        height: radius * 0.7
                    )),
                    with: .radialGradient(coreGradient, center: center, startRadius: 0, endRadius: radius * 0.35)
                )

                // Inner ring
                let ringPath = Path(ellipseIn: CGRect(
                    x: center.x - radius * 0.55,
                    y: center.y - radius * 0.55,
                    width: radius * 1.1,
                    height: radius * 1.1
                ))
                context.stroke(
                    ringPath,
                    with: .color(coreColor.opacity(glowIntensity * 0.5)),
                    lineWidth: 1.5
                )

                // Outer ring
                let outerRing = Path(ellipseIn: CGRect(
                    x: center.x - radius * 0.85,
                    y: center.y - radius * 0.85,
                    width: radius * 1.7,
                    height: radius * 1.7
                ))
                context.stroke(
                    outerRing,
                    with: .color(coreColor.opacity(glowIntensity * 0.3)),
                    lineWidth: 1.0
                )

                // Rotating segments (4 segments for watch, vs 8 on macOS)
                let currentRotation = now * rotationSpeed
                for i in 0..<4 {
                    let angle = currentRotation + Double(i) * (.pi / 2)
                    let segLength: CGFloat = radius * 0.25

                    let startR = radius * 0.6
                    let endR = startR + segLength

                    let x1 = center.x + cos(CGFloat(angle)) * startR
                    let y1 = center.y + sin(CGFloat(angle)) * startR
                    let x2 = center.x + cos(CGFloat(angle)) * endR
                    let y2 = center.y + sin(CGFloat(angle)) * endR

                    var segPath = Path()
                    segPath.move(to: CGPoint(x: x1, y: y1))
                    segPath.addLine(to: CGPoint(x: x2, y: y2))

                    context.stroke(
                        segPath,
                        with: .color(coreColor.opacity(glowIntensity * 0.7)),
                        lineWidth: 2.0
                    )
                }

                // Small particles (10 for watch vs 35 on macOS)
                for i in 0..<10 {
                    let seed = Double(i) * 1.7 + 0.5
                    let particleAngle = now * (0.3 + seed * 0.15) + seed * 2.5
                    let particleR = radius * CGFloat(0.25 + (seed.truncatingRemainder(dividingBy: 0.6)) + sin(now * seed * 0.5) * 0.1)

                    let px = center.x + cos(CGFloat(particleAngle)) * particleR
                    let py = center.y + sin(CGFloat(particleAngle)) * particleR
                    let pSize: CGFloat = 1.0 + CGFloat(seed.truncatingRemainder(dividingBy: 1.0))
                    let pAlpha = glowIntensity * (0.3 + (seed.truncatingRemainder(dividingBy: 0.5)))

                    context.fill(
                        Path(ellipseIn: CGRect(x: px - pSize/2, y: py - pSize/2, width: pSize, height: pSize)),
                        with: .color(coreColor.opacity(pAlpha))
                    )
                }
            }
            .onChange(of: timeline.date) { _ in
                pulsePhase += 1.0 / 60.0
            }
        }
        .frame(width: size, height: size)
    }
}
