use crate::Document;
use ordered_float::OrderedFloat;
use std::collections::HashMap;

/// In-memory vector index using brute-force cosine similarity.
///
/// For JARVIS's memory size (hundreds to low thousands of documents),
/// brute-force on 384-dim vectors is <1ms. HNSW is overkill until we
/// hit 100K+ docs. Keep it simple.
pub struct VectorIndex {
    documents: HashMap<String, Document>,
}

impl VectorIndex {
    pub fn new() -> Self {
        Self {
            documents: HashMap::new(),
        }
    }

    pub fn insert(&mut self, doc: Document) {
        self.documents.insert(doc.id.clone(), doc);
    }

    pub fn remove(&mut self, id: &str) -> bool {
        self.documents.remove(id).is_some()
    }

    pub fn len(&self) -> usize {
        self.documents.len()
    }

    /// Search for the top-k most similar documents to the query embedding.
    pub fn search(&self, query: &[f32], top_k: usize, threshold: f32) -> Vec<(&Document, f32)> {
        let mut scored: Vec<(&Document, f32)> = self
            .documents
            .values()
            .filter_map(|doc| {
                let emb = doc.embedding.as_ref()?;
                let score = cosine_similarity(query, emb);
                if score >= threshold {
                    Some((doc, score))
                } else {
                    None
                }
            })
            .collect();

        // Sort descending by score
        scored.sort_by(|a, b| OrderedFloat(b.1).cmp(&OrderedFloat(a.1)));
        scored.truncate(top_k);
        scored
    }
}

/// Cosine similarity between two vectors.
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let mut dot = 0.0_f32;
    let mut norm_a = 0.0_f32;
    let mut norm_b = 0.0_f32;

    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }

    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_identical() {
        let v = vec![1.0, 2.0, 3.0];
        let sim = cosine_similarity(&v, &v);
        assert!((sim - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_cosine_orthogonal() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.abs() < 1e-5);
    }

    #[test]
    fn test_insert_search() {
        let mut idx = VectorIndex::new();
        idx.insert(Document {
            id: "a".into(),
            text: "hello world".into(),
            metadata: serde_json::Value::Null,
            embedding: Some(vec![1.0, 0.0, 0.0]),
        });
        idx.insert(Document {
            id: "b".into(),
            text: "goodbye world".into(),
            metadata: serde_json::Value::Null,
            embedding: Some(vec![0.0, 1.0, 0.0]),
        });

        let results = idx.search(&[1.0, 0.1, 0.0], 1, 0.0);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0.id, "a");
    }
}
