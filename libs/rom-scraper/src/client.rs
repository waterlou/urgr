use std::time::Duration;

#[derive(Clone)]
pub struct HttpClient {
    inner: reqwest::Client,
    user_agent: String,
}

impl HttpClient {
    pub fn new() -> Self {
        let inner = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(4)
            .build()
            .expect("Failed to build HTTP client");

        Self {
            inner,
            user_agent: format!("GameManager/{}", env!("CARGO_PKG_VERSION")),
        }
    }

    pub fn with_user_agent(mut self, ua: &str) -> Self {
        self.user_agent = ua.to_string();
        self
    }

    pub fn inner(&self) -> &reqwest::Client {
        &self.inner
    }

    pub fn user_agent(&self) -> &str {
        &self.user_agent
    }

    pub async fn get_text(&self, url: &str) -> crate::Result<String> {
        let resp = self
            .inner
            .get(url)
            .header("User-Agent", &self.user_agent)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(crate::Error::Source(format!(
                "HTTP {} from {}",
                status.as_u16(),
                url
            )));
        }
        Ok(resp.text().await?)
    }

    pub async fn get_bytes(&self, url: &str) -> crate::Result<Vec<u8>> {
        let resp = self
            .inner
            .get(url)
            .header("User-Agent", &self.user_agent)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(crate::Error::Source(format!(
                "HTTP {} from {}",
                status.as_u16(),
                url
            )));
        }
        Ok(resp.bytes().await?.to_vec())
    }

    pub async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
    ) -> crate::Result<T> {
        let resp = self
            .inner
            .get(url)
            .header("User-Agent", &self.user_agent)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(crate::Error::Source(format!(
                "HTTP {} from {}",
                status.as_u16(),
                url
            )));
        }
        Ok(resp.json().await?)
    }
}

impl Default for HttpClient {
    fn default() -> Self {
        Self::new()
    }
}
