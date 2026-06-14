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
        for i in 1..=3 {
            let resp = self.inner.get(url).header("User-Agent", &self.user_agent).send().await?;
            let status = resp.status().as_u16();
            if status == 200 { return Ok(resp.text().await?); }
            if status != 429 { return Err(crate::Error::Source(format!("HTTP {} from {}", status, url))); }
            let secs = retry_after(&resp, i);
            tokio::time::sleep(Duration::from_secs(secs)).await;
        }
        Err(crate::Error::Source(format!("Rate limited on {}", url)))
    }

    pub async fn get_bytes(&self, url: &str) -> crate::Result<Vec<u8>> {
        for i in 1..=3 {
            let resp = self.inner.get(url).header("User-Agent", &self.user_agent).send().await?;
            let status = resp.status().as_u16();
            if status == 200 { return Ok(resp.bytes().await?.to_vec()); }
            if status != 429 { return Err(crate::Error::Source(format!("HTTP {} from {}", status, url))); }
            let secs = retry_after(&resp, i);
            tokio::time::sleep(Duration::from_secs(secs)).await;
        }
        Err(crate::Error::Source(format!("Rate limited on {}", url)))
    }

    pub async fn get_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> crate::Result<T> {
        for i in 1..=3 {
            let resp = self.inner.get(url).header("User-Agent", &self.user_agent).send().await?;
            let status = resp.status().as_u16();
            if status == 200 { return Ok(resp.json().await?); }
            if status != 429 { return Err(crate::Error::Source(format!("HTTP {} from {}", status, url))); }
            let secs = retry_after(&resp, i);
            tokio::time::sleep(Duration::from_secs(secs)).await;
        }
        Err(crate::Error::Source(format!("Rate limited on {}", url)))
    }

    pub async fn head(&self, url: &str) -> crate::Result<reqwest::Response> {
        let resp = self.inner.head(url)
            .header("User-Agent", &self.user_agent)
            .send().await?;
        let status = resp.status().as_u16();
        if status == 200 { Ok(resp) } else {
            Err(crate::Error::Source(format!("HTTP {} from {}", status, url)))
        }
    }

    pub async fn post_form_json<T: serde::de::DeserializeOwned>(
        &self, url: &str, params: &[(&str, &str)],
    ) -> crate::Result<T> {
        for i in 1..=3 {
            let resp = self.inner.post(url)
                .header("User-Agent", &self.user_agent)
                .form(params)
                .send().await?;
            let status = resp.status().as_u16();
            if status == 200 { return Ok(resp.json().await?); }
            if status != 429 { return Err(crate::Error::Source(format!("HTTP {} from {}", status, url))); }
            let secs = retry_after(&resp, i);
            tokio::time::sleep(Duration::from_secs(secs)).await;
        }
        Err(crate::Error::Source(format!("Rate limited on {}", url)))
    }
}

fn retry_after(resp: &reqwest::Response, attempt: u32) -> u64 {
    let header = resp.headers().get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(10);
    let adaptive = 2u64.pow(attempt);
    header.min(60).max(adaptive.min(30))
}

impl Default for HttpClient {
    fn default() -> Self {
        Self::new()
    }
}
