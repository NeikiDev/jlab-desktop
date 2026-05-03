use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppError {
    #[error("file exceeds {max_mb} MB limit")]
    TooLarge { max_mb: u64 },

    #[error("rate limited; retry in {retry_after_seconds} s")]
    RateLimited { retry_after_seconds: u64 },

    #[error("server returned {status}: {message}")]
    Server { status: u16, message: String },

    #[error("network error: {message}")]
    Network { message: String },

    #[error("io error: {message}")]
    Io { message: String },

    #[error("invalid response: {message}")]
    InvalidResponse { message: String },

    #[error("unsupported file type")]
    UnsupportedFile {
        extension: Option<String>,
        allowed: Vec<String>,
    },

    #[error("archive does not contain a .jar file")]
    NoJarInArchive,

    #[error("invalid archive: {message}")]
    InvalidArchive { message: String },

    #[error("scan cancelled by user")]
    Cancelled,

    #[error("history storage error: {message}")]
    HistoryIo { message: String },
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io {
            message: e.to_string(),
        }
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network {
            message: e.to_string(),
        }
    }
}
