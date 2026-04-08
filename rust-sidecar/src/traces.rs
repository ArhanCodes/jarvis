use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Trace types (mirror the TS types)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceContext {
    #[serde(rename = "timeOfDay")]
    pub time_of_day: String,
    #[serde(rename = "dayOfWeek")]
    pub day_of_week: u8,
    #[serde(rename = "activeApp")]
    pub active_app: Option<String>,
    #[serde(rename = "voiceMode")]
    pub voice_mode: bool,
    #[serde(rename = "previousCommand")]
    pub previous_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceResult {
    pub success: bool,
    pub message: String,
    #[serde(rename = "latencyMs")]
    pub latency_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trace {
    pub id: String,
    pub timestamp: u64,
    pub input: String,
    pub module: String,
    pub action: String,
    pub args: HashMap<String, String>,
    pub result: TraceResult,
    pub context: TraceContext,
    pub feedback: Option<String>,
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct TraceStats {
    pub total_traces: usize,
    pub success_rate: f64,
    pub top_modules: Vec<ModuleStat>,
    pub top_patterns: Vec<PatternStat>,
    pub average_latency: f64,
    pub sequence_patterns: Vec<SequencePattern>,
    pub time_distribution: HashMap<String, usize>,
    pub failure_hotspots: Vec<FailureHotspot>,
}

#[derive(Debug, Serialize)]
pub struct ModuleStat {
    pub module: String,
    pub count: usize,
    pub success_rate: f64,
    pub avg_latency: f64,
}

#[derive(Debug, Serialize)]
pub struct PatternStat {
    pub pattern: String,
    pub count: usize,
}

#[derive(Debug, Serialize)]
pub struct SequencePattern {
    pub first: String,
    pub then: String,
    pub count: usize,
}

#[derive(Debug, Serialize)]
pub struct FailureHotspot {
    pub module: String,
    pub action: String,
    pub failure_count: usize,
    pub total_count: usize,
    pub failure_rate: f64,
    pub common_error: String,
}

/// Compute comprehensive trace analytics in a single pass where possible.
pub fn analyze_traces(traces: &[Trace]) -> TraceStats {
    if traces.is_empty() {
        return TraceStats {
            total_traces: 0,
            success_rate: 0.0,
            top_modules: vec![],
            top_patterns: vec![],
            average_latency: 0.0,
            sequence_patterns: vec![],
            time_distribution: HashMap::new(),
            failure_hotspots: vec![],
        };
    }

    let total = traces.len();
    let mut successes = 0usize;
    let mut total_latency = 0.0_f64;

    // Module stats: module -> (count, successes, total_latency)
    let mut module_stats: HashMap<&str, (usize, usize, f64)> = HashMap::new();
    // Time-of-day patterns: "timeOfDay:module" -> count
    let mut pattern_counts: HashMap<String, usize> = HashMap::new();
    // Time distribution: timeOfDay -> count
    let mut time_dist: HashMap<String, usize> = HashMap::new();
    // Failure tracking: "module:action" -> (failures, total, error messages)
    let mut failure_map: HashMap<String, (usize, usize, HashMap<String, usize>)> = HashMap::new();

    // Single pass through all traces
    for t in traces {
        if t.result.success {
            successes += 1;
        }
        total_latency += t.result.latency_ms;

        // Module stats
        let entry = module_stats.entry(&t.module).or_insert((0, 0, 0.0));
        entry.0 += 1;
        if t.result.success {
            entry.1 += 1;
        }
        entry.2 += t.result.latency_ms;

        // Pattern: timeOfDay:module
        let pattern_key = format!("{}:{}", t.context.time_of_day, t.module);
        *pattern_counts.entry(pattern_key).or_insert(0) += 1;

        // Time distribution
        *time_dist.entry(t.context.time_of_day.clone()).or_insert(0) += 1;

        // Failure tracking
        let fa_key = format!("{}:{}", t.module, t.action);
        let fa_entry = failure_map.entry(fa_key).or_insert((0, 0, HashMap::new()));
        fa_entry.1 += 1;
        if !t.result.success {
            fa_entry.0 += 1;
            // Track error message frequency (truncate for grouping)
            let err_msg = if t.result.message.len() > 80 {
                t.result.message[..80].to_string()
            } else {
                t.result.message.clone()
            };
            *fa_entry.2.entry(err_msg).or_insert(0) += 1;
        }
    }

    // Build top modules
    let mut top_modules: Vec<ModuleStat> = module_stats
        .iter()
        .map(|(module, (count, succ, lat))| ModuleStat {
            module: module.to_string(),
            count: *count,
            success_rate: if *count > 0 { *succ as f64 / *count as f64 } else { 0.0 },
            avg_latency: if *count > 0 { lat / *count as f64 } else { 0.0 },
        })
        .collect();
    top_modules.sort_by(|a, b| b.count.cmp(&a.count));
    top_modules.truncate(10);

    // Build top patterns
    let mut top_patterns: Vec<PatternStat> = pattern_counts
        .into_iter()
        .map(|(pattern, count)| PatternStat { pattern, count })
        .collect();
    top_patterns.sort_by(|a, b| b.count.cmp(&a.count));
    top_patterns.truncate(15);

    // Sequence detection (pairs within 10 minutes)
    let sequence_patterns = detect_sequences(traces);

    // Failure hotspots
    let mut failure_hotspots: Vec<FailureHotspot> = failure_map
        .into_iter()
        .filter(|(_, (failures, _, _))| *failures > 0)
        .map(|(key, (failures, total, errors))| {
            let parts: Vec<&str> = key.splitn(2, ':').collect();
            let common_error = errors
                .into_iter()
                .max_by_key(|(_, count)| *count)
                .map(|(msg, _)| msg)
                .unwrap_or_default();
            FailureHotspot {
                module: parts.first().unwrap_or(&"").to_string(),
                action: parts.get(1).unwrap_or(&"").to_string(),
                failure_count: failures,
                total_count: total,
                failure_rate: failures as f64 / total as f64,
                common_error,
            }
        })
        .collect();
    failure_hotspots.sort_by(|a, b| b.failure_count.cmp(&a.failure_count));
    failure_hotspots.truncate(10);

    TraceStats {
        total_traces: total,
        success_rate: successes as f64 / total as f64,
        top_modules,
        top_patterns,
        average_latency: total_latency / total as f64,
        sequence_patterns,
        time_distribution: time_dist,
        failure_hotspots,
    }
}

/// Detect command sequence patterns (pairs that often follow each other).
fn detect_sequences(traces: &[Trace]) -> Vec<SequencePattern> {
    let mut pair_counts: HashMap<(String, String), usize> = HashMap::new();
    let ten_minutes_ms = 10 * 60 * 1000;

    for i in 1..traces.len() {
        let prev = &traces[i - 1];
        let curr = &traces[i];

        if curr.timestamp.saturating_sub(prev.timestamp) > ten_minutes_ms {
            continue;
        }

        let first = format!("{}:{}", prev.module, prev.action);
        let then = format!("{}:{}", curr.module, curr.action);
        *pair_counts.entry((first, then)).or_insert(0) += 1;
    }

    let mut patterns: Vec<SequencePattern> = pair_counts
        .into_iter()
        .filter(|(_, count)| *count >= 2)
        .map(|((first, then), count)| SequencePattern { first, then, count })
        .collect();

    patterns.sort_by(|a, b| b.count.cmp(&a.count));
    patterns.truncate(20);
    patterns
}

/// Detect habits: commands frequently run at specific times/days.
#[derive(Debug, Serialize)]
pub struct HabitPattern {
    pub command: String,
    pub time_of_day: String,
    pub day_of_week: Option<u8>,
    pub occurrences: usize,
    pub regularity: f64, // 0.0-1.0, how consistent this habit is
}

pub fn detect_habits(traces: &[Trace], min_occurrences: usize) -> Vec<HabitPattern> {
    // Group by (command, timeOfDay, dayOfWeek)
    let mut habit_counts: HashMap<(String, String, u8), usize> = HashMap::new();
    let mut time_counts: HashMap<(String, String), usize> = HashMap::new();
    let mut total_by_command: HashMap<String, usize> = HashMap::new();

    for t in traces {
        let cmd = format!("{}:{}", t.module, t.action);
        let key = (cmd.clone(), t.context.time_of_day.clone(), t.context.day_of_week);
        *habit_counts.entry(key).or_insert(0) += 1;

        let time_key = (cmd.clone(), t.context.time_of_day.clone());
        *time_counts.entry(time_key).or_insert(0) += 1;

        *total_by_command.entry(cmd).or_insert(0) += 1;
    }

    let mut habits: Vec<HabitPattern> = Vec::new();

    // Check time-of-day habits (ignoring day of week)
    for ((cmd, tod), count) in &time_counts {
        if *count >= min_occurrences {
            let total = total_by_command.get(cmd).copied().unwrap_or(1);
            let regularity = *count as f64 / total as f64;
            habits.push(HabitPattern {
                command: cmd.clone(),
                time_of_day: tod.clone(),
                day_of_week: None,
                occurrences: *count,
                regularity,
            });
        }
    }

    // Check day-specific habits
    for ((cmd, tod, dow), count) in &habit_counts {
        if *count >= min_occurrences.max(3) {
            let total = total_by_command.get(cmd).copied().unwrap_or(1);
            let regularity = *count as f64 / total as f64;
            habits.push(HabitPattern {
                command: cmd.clone(),
                time_of_day: tod.clone(),
                day_of_week: Some(*dow),
                occurrences: *count,
                regularity,
            });
        }
    }

    habits.sort_by(|a, b| b.occurrences.cmp(&a.occurrences));
    habits.truncate(20);
    habits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_trace(module: &str, action: &str, ts: u64, success: bool) -> Trace {
        Trace {
            id: format!("t-{ts}"),
            timestamp: ts,
            input: format!("{module} {action}"),
            module: module.into(),
            action: action.into(),
            args: HashMap::new(),
            result: TraceResult {
                success,
                message: if success { "ok".into() } else { "failed".into() },
                latency_ms: 50.0,
            },
            context: TraceContext {
                time_of_day: "morning".into(),
                day_of_week: 1,
                active_app: None,
                voice_mode: false,
                previous_command: None,
            },
            feedback: None,
        }
    }

    #[test]
    fn test_analyze_empty() {
        let stats = analyze_traces(&[]);
        assert_eq!(stats.total_traces, 0);
    }

    #[test]
    fn test_sequence_detection() {
        let traces = vec![
            make_trace("spotify", "play", 1000, true),
            make_trace("system-monitor", "battery", 2000, true),
            make_trace("spotify", "play", 100_000, true),
            make_trace("system-monitor", "battery", 101_000, true),
        ];
        let stats = analyze_traces(&traces);
        assert!(!stats.sequence_patterns.is_empty());
        assert_eq!(stats.sequence_patterns[0].count, 2);
    }
}
