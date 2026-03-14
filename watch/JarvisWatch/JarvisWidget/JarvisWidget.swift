import WidgetKit
import SwiftUI

// MARK: - Timeline

struct JarvisEntry: TimelineEntry {
    let date: Date
}

struct JarvisProvider: TimelineProvider {
    func placeholder(in context: Context) -> JarvisEntry {
        JarvisEntry(date: .now)
    }

    func getSnapshot(in context: Context, completion: @escaping (JarvisEntry) -> Void) {
        completion(JarvisEntry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<JarvisEntry>) -> Void) {
        let entry = JarvisEntry(date: .now)
        let timeline = Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(3600)))
        completion(timeline)
    }
}

// MARK: - Widget Views

struct JarvisWidgetSmallView: View {
    var body: some View {
        ZStack {
            Color.black

            VStack(spacing: 8) {
                // Arc reactor
                ZStack {
                    Circle()
                        .stroke(Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.3), lineWidth: 2)
                        .frame(width: 60, height: 60)

                    Circle()
                        .stroke(Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.6), lineWidth: 1.5)
                        .frame(width: 45, height: 45)

                    Circle()
                        .fill(
                            RadialGradient(
                                gradient: Gradient(colors: [
                                    Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.8),
                                    Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.2),
                                    .clear
                                ]),
                                center: .center,
                                startRadius: 3,
                                endRadius: 20
                            )
                        )
                        .frame(width: 35, height: 35)

                    Circle()
                        .fill(Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.9))
                        .frame(width: 12, height: 12)
                        .shadow(color: Color(red: 1.0, green: 0.72, blue: 0.22), radius: 8)

                    // Mic icon overlay
                    Image(systemName: "mic.fill")
                        .font(.system(size: 14))
                        .foregroundColor(.white.opacity(0.9))
                }

                Text("JARVIS")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundColor(Color(red: 1.0, green: 0.72, blue: 0.22))
                    .tracking(2)

                Text("Tap to talk")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(.white.opacity(0.5))
            }
        }
        .widgetURL(URL(string: "jarvis://talk"))
    }
}

struct JarvisWidgetMediumView: View {
    var body: some View {
        ZStack {
            Color.black

            HStack(spacing: 16) {
                // Arc reactor
                ZStack {
                    Circle()
                        .stroke(Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.3), lineWidth: 2)
                        .frame(width: 70, height: 70)

                    Circle()
                        .stroke(Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.6), lineWidth: 1.5)
                        .frame(width: 52, height: 52)

                    Circle()
                        .fill(
                            RadialGradient(
                                gradient: Gradient(colors: [
                                    Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.8),
                                    Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.2),
                                    .clear
                                ]),
                                center: .center,
                                startRadius: 4,
                                endRadius: 24
                            )
                        )
                        .frame(width: 40, height: 40)

                    Circle()
                        .fill(Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.9))
                        .frame(width: 14, height: 14)
                        .shadow(color: Color(red: 1.0, green: 0.72, blue: 0.22), radius: 8)

                    Image(systemName: "mic.fill")
                        .font(.system(size: 16))
                        .foregroundColor(.white.opacity(0.9))
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("JARVIS")
                        .font(.system(size: 16, weight: .bold, design: .monospaced))
                        .foregroundColor(Color(red: 1.0, green: 0.72, blue: 0.22))
                        .tracking(3)

                    Text("Tap to activate")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white.opacity(0.6))

                    Text("STANDING BY")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundColor(Color(red: 1.0, green: 0.72, blue: 0.22).opacity(0.6))
                        .tracking(1)
                }

                Spacer()
            }
            .padding(.horizontal, 16)
        }
        .widgetURL(URL(string: "jarvis://talk"))
    }
}

// MARK: - Widget

struct JarvisWidget: Widget {
    let kind = "JarvisWidget"

    @Environment(\.widgetFamily) var family

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: JarvisProvider()) { _ in
            JarvisWidgetEntryView()
                .containerBackground(.black, for: .widget)
        }
        .configurationDisplayName("JARVIS")
        .description("Tap to talk to JARVIS")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct JarvisWidgetEntryView: View {
    @Environment(\.widgetFamily) var family

    var body: some View {
        switch family {
        case .systemMedium:
            JarvisWidgetMediumView()
        default:
            JarvisWidgetSmallView()
        }
    }
}
