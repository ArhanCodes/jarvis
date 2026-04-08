mod vector;
mod embeddings;
mod fuzzy;
mod traces;

use actix_web::{web, App, HttpServer, HttpResponse};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use parking_lot::RwLock;

use vector::VectorIndex;
use embeddings::TextEmbedder;
use fuzzy::KeywordEntry;
use traces::Trace;

// ---------------------------------------------------------------------------
// Types — Vector Search
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub text: String,
    pub metadata: serde_json::Value,
    pub embedding: Option<Vec<f32>>,
}

#[derive(Debug, Deserialize)]
pub struct IndexRequest {
    pub id: String,
    pub text: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    pub top_k: Option<usize>,
    pub threshold: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub id: String,
    pub text: String,
    pub score: f32,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct EmbedRequest {
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct BulkIndexRequest {
    pub documents: Vec<IndexRequest>,
}

// ---------------------------------------------------------------------------
// Types — Fuzzy Match
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct FuzzyRequest {
    pub input: String,
    pub keywords: Vec<KeywordEntry>,
    pub max_distance: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct LevenshteinRequest {
    pub a: String,
    pub b: String,
}

#[derive(Debug, Deserialize)]
pub struct BatchLevenshteinRequest {
    pub input: String,
    pub candidates: Vec<String>,
    pub max_distance: Option<usize>,
}

// ---------------------------------------------------------------------------
// Types — Trace Analytics
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TraceAnalyticsRequest {
    pub traces: Vec<Trace>,
}

#[derive(Debug, Deserialize)]
pub struct HabitDetectionRequest {
    pub traces: Vec<Trace>,
    pub min_occurrences: Option<usize>,
}

// ---------------------------------------------------------------------------
// Types — Stats
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct StatsResponse {
    pub document_count: usize,
    pub vocab_size: usize,
    pub uptime_seconds: u64,
}

// ---------------------------------------------------------------------------
// App State
// ---------------------------------------------------------------------------

pub struct AppState {
    pub index: RwLock<VectorIndex>,
    pub embedder: TextEmbedder,
    pub start_time: std::time::Instant,
}

// ---------------------------------------------------------------------------
// Handlers — Health & Stats
// ---------------------------------------------------------------------------

async fn health() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "ok",
        "service": "jarvis-core",
        "capabilities": ["vector-search", "fuzzy-match", "trace-analytics", "embeddings"]
    }))
}

async fn stats(state: web::Data<Arc<AppState>>) -> HttpResponse {
    let idx = state.index.read();
    HttpResponse::Ok().json(StatsResponse {
        document_count: idx.len(),
        vocab_size: state.embedder.vocab_size(),
        uptime_seconds: state.start_time.elapsed().as_secs(),
    })
}

// ---------------------------------------------------------------------------
// Handlers — Vector Search
// ---------------------------------------------------------------------------

async fn index_document(
    state: web::Data<Arc<AppState>>,
    body: web::Json<IndexRequest>,
) -> HttpResponse {
    let embedding = state.embedder.embed(&body.text);
    let doc = Document {
        id: body.id.clone(),
        text: body.text.clone(),
        metadata: body.metadata.clone().unwrap_or(serde_json::Value::Null),
        embedding: Some(embedding),
    };

    state.index.write().insert(doc);
    HttpResponse::Ok().json(serde_json::json!({ "status": "indexed", "id": body.id }))
}

async fn bulk_index(
    state: web::Data<Arc<AppState>>,
    body: web::Json<BulkIndexRequest>,
) -> HttpResponse {
    let mut idx = state.index.write();
    let count = body.documents.len();

    for req in &body.documents {
        let embedding = state.embedder.embed(&req.text);
        let doc = Document {
            id: req.id.clone(),
            text: req.text.clone(),
            metadata: req.metadata.clone().unwrap_or(serde_json::Value::Null),
            embedding: Some(embedding),
        };
        idx.insert(doc);
    }

    HttpResponse::Ok().json(serde_json::json!({ "status": "indexed", "count": count }))
}

async fn search(
    state: web::Data<Arc<AppState>>,
    body: web::Json<SearchRequest>,
) -> HttpResponse {
    let query_embedding = state.embedder.embed(&body.query);
    let top_k = body.top_k.unwrap_or(5);
    let threshold = body.threshold.unwrap_or(0.0);

    let idx = state.index.read();
    let results = idx.search(&query_embedding, top_k, threshold);

    let response: Vec<SearchResult> = results
        .into_iter()
        .map(|(doc, score)| SearchResult {
            id: doc.id.clone(),
            text: doc.text.clone(),
            score,
            metadata: doc.metadata.clone(),
        })
        .collect();

    HttpResponse::Ok().json(response)
}

async fn embed_text(
    state: web::Data<Arc<AppState>>,
    body: web::Json<EmbedRequest>,
) -> HttpResponse {
    let embedding = state.embedder.embed(&body.text);
    HttpResponse::Ok().json(serde_json::json!({ "embedding": embedding, "dimensions": embedding.len() }))
}

async fn delete_document(
    state: web::Data<Arc<AppState>>,
    path: web::Path<String>,
) -> HttpResponse {
    let id = path.into_inner();
    let removed = state.index.write().remove(&id);
    if removed {
        HttpResponse::Ok().json(serde_json::json!({ "status": "deleted", "id": id }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({ "error": "not found", "id": id }))
    }
}

// ---------------------------------------------------------------------------
// Handlers — Fuzzy Match / Levenshtein
// ---------------------------------------------------------------------------

async fn fuzzy_match_handler(body: web::Json<FuzzyRequest>) -> HttpResponse {
    let input_lower = body.input.to_lowercase();
    let words: Vec<&str> = input_lower.split_whitespace().collect();
    let max_dist = body.max_distance.unwrap_or(2);

    match fuzzy::fuzzy_match(&words, &body.keywords, max_dist) {
        Some(m) => HttpResponse::Ok().json(m),
        None => HttpResponse::Ok().json(serde_json::json!(null)),
    }
}

async fn levenshtein_handler(body: web::Json<LevenshteinRequest>) -> HttpResponse {
    let dist = fuzzy::levenshtein(&body.a, &body.b);
    HttpResponse::Ok().json(serde_json::json!({ "distance": dist }))
}

async fn batch_levenshtein_handler(body: web::Json<BatchLevenshteinRequest>) -> HttpResponse {
    let max_dist = body.max_distance.unwrap_or(3);
    let results = fuzzy::batch_levenshtein(&body.input, &body.candidates, max_dist);
    HttpResponse::Ok().json(results)
}

// ---------------------------------------------------------------------------
// Handlers — Trace Analytics
// ---------------------------------------------------------------------------

async fn trace_analytics_handler(body: web::Json<TraceAnalyticsRequest>) -> HttpResponse {
    let stats = traces::analyze_traces(&body.traces);
    HttpResponse::Ok().json(stats)
}

async fn habit_detection_handler(body: web::Json<HabitDetectionRequest>) -> HttpResponse {
    let min_occ = body.min_occurrences.unwrap_or(3);
    let habits = traces::detect_habits(&body.traces, min_occ);
    HttpResponse::Ok().json(habits)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let port: u16 = std::env::var("JARVIS_CORE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7700);

    println!("[jarvis-core] Starting on port {port} — vector search, fuzzy match, trace analytics");

    let state = Arc::new(AppState {
        index: RwLock::new(VectorIndex::new()),
        embedder: TextEmbedder::new(),
        start_time: std::time::Instant::now(),
    });

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(state.clone()))
            .app_data(web::JsonConfig::default().limit(10 * 1024 * 1024)) // 10MB
            // Health & stats
            .route("/health", web::get().to(health))
            .route("/stats", web::get().to(stats))
            // Vector search
            .route("/index", web::post().to(index_document))
            .route("/bulk-index", web::post().to(bulk_index))
            .route("/search", web::post().to(search))
            .route("/embed", web::post().to(embed_text))
            .route("/document/{id}", web::delete().to(delete_document))
            // Fuzzy matching
            .route("/fuzzy-match", web::post().to(fuzzy_match_handler))
            .route("/levenshtein", web::post().to(levenshtein_handler))
            .route("/batch-levenshtein", web::post().to(batch_levenshtein_handler))
            // Trace analytics
            .route("/trace-analytics", web::post().to(trace_analytics_handler))
            .route("/detect-habits", web::post().to(habit_detection_handler))
    })
    .bind(("127.0.0.1", port))?
    .workers(2)
    .run()
    .await
}
