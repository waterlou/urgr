use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("{0}")]
    Source(String),

    #[error("No scraper available for: {0}")]
    NoScraper(String),
}

pub type Result<T> = std::result::Result<T, Error>;
