use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("XML error: {0}")]
    Xml(String),

    #[error("XML writer error: {0}")]
    XmlWrite(#[from] quick_xml::Error),

    #[error("{0}")]
    Source(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Rom scraper error: {0}")]
    RomScraper(#[from] rom_scraper::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
