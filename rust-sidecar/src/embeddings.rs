use std::collections::HashMap;
use parking_lot::RwLock;

/// Lightweight TF-IDF text embedder.
///
/// Produces sparse-ish fixed-dimension vectors by hashing tokens into buckets.
/// This is intentionally simple — no ML model, no downloads, instant startup.
/// Upgrade path: swap this for candle + a real model later.
const EMBED_DIM: usize = 384;

pub struct TextEmbedder {
    /// Global document frequency: token → number of documents containing it
    df: RwLock<HashMap<String, usize>>,
    /// Total documents indexed (for IDF calculation)
    doc_count: RwLock<usize>,
}

impl TextEmbedder {
    pub fn new() -> Self {
        Self {
            df: RwLock::new(HashMap::new()),
            doc_count: RwLock::new(0),
        }
    }

    /// Register a document's tokens so IDF weights stay up to date.
    pub fn observe(&self, text: &str) {
        let tokens = tokenize(text);
        let unique: std::collections::HashSet<&str> = tokens.iter().map(|s| s.as_str()).collect();

        let mut df = self.df.write();
        for tok in unique {
            *df.entry(tok.to_string()).or_insert(0) += 1;
        }
        *self.doc_count.write() += 1;
    }

    /// Produce an embedding vector for the given text.
    pub fn embed(&self, text: &str) -> Vec<f32> {
        let tokens = tokenize(text);
        if tokens.is_empty() {
            return vec![0.0; EMBED_DIM];
        }

        // Term frequency
        let mut tf: HashMap<&str, f32> = HashMap::new();
        for tok in &tokens {
            *tf.entry(tok.as_str()).or_insert(0.0) += 1.0;
        }
        let max_tf = tf.values().cloned().fold(0.0_f32, f32::max).max(1.0);

        let df = self.df.read();
        let n = (*self.doc_count.read()).max(1) as f32;

        let mut vec = vec![0.0_f32; EMBED_DIM];

        for (tok, count) in &tf {
            let norm_tf = 0.5 + 0.5 * (count / max_tf);
            let idf = (n / (*df.get(*tok).unwrap_or(&1) as f32)).ln() + 1.0;
            let weight = norm_tf * idf;

            // Hash token to multiple buckets (pseudo-random projection)
            let h1 = hash_token(tok, 0) % EMBED_DIM;
            let h2 = hash_token(tok, 1) % EMBED_DIM;
            let h3 = hash_token(tok, 2) % EMBED_DIM;

            vec[h1] += weight;
            vec[h2] += weight * 0.7;
            vec[h3] -= weight * 0.5; // negative projection for better separation
        }

        // L2 normalize
        let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for v in &mut vec {
                *v /= norm;
            }
        }

        vec
    }

    pub fn vocab_size(&self) -> usize {
        self.df.read().len()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|s| s.len() >= 2)
        .map(|s| stem(s))
        .collect()
}

/// Minimal Porter-style suffix stripping. Not a full stemmer but good enough
/// for semantic bucketing.
fn stem(word: &str) -> String {
    let w = word.to_string();
    if w.len() <= 3 {
        return w;
    }

    let w = w.strip_suffix("ing").map(|s| s.to_string())
        .or_else(|| w.strip_suffix("tion").map(|s| format!("{s}te")))
        .or_else(|| w.strip_suffix("ness").map(|s| s.to_string()))
        .or_else(|| w.strip_suffix("ment").map(|s| s.to_string()))
        .or_else(|| w.strip_suffix("able").map(|s| s.to_string()))
        .or_else(|| w.strip_suffix("ible").map(|s| s.to_string()))
        .or_else(|| w.strip_suffix("ally").map(|s| s.to_string()))
        .or_else(|| w.strip_suffix("ies").map(|s| format!("{s}y")))
        .or_else(|| w.strip_suffix("ous").map(|s| s.to_string()))
        .or_else(|| w.strip_suffix("ful").map(|s| s.to_string()))
        .or_else(|| {
            if w.ends_with("ed") && w.len() > 4 {
                Some(w.strip_suffix("ed").unwrap().to_string())
            } else {
                None
            }
        })
        .or_else(|| {
            if w.ends_with('s') && !w.ends_with("ss") && w.len() > 3 {
                Some(w.strip_suffix('s').unwrap().to_string())
            } else {
                None
            }
        })
        .unwrap_or(w);

    w
}

/// FNV-1a hash with a seed for multiple projections.
fn hash_token(token: &str, seed: u64) -> usize {
    let mut hash: u64 = 14695981039346656037_u64.wrapping_add(seed.wrapping_mul(1099511628211));
    for byte in token.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    hash as usize
}
