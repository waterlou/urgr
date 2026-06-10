use serde::Deserialize;

/// Log in to Internet Archive and return a cookie-authenticated client.
/// The client can then be used to download private files.
pub async fn login(
    username: &str,
    password: &str,
) -> Result<reqwest::Client, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .cookie_store(true)
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    // Get login page first to get any initial cookies
    let _ = client.get("https://archive.org/login").send().await;

    // Submit login form
    let resp = client
        .post("https://archive.org/account/login")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!("username={}&password={}&action=login&referer=https%3A%2F%2Farchive.org%2F",
            urlencoding(username), urlencoding(password)))
        .send()
        .await
        .map_err(|e| format!("Login request error: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if !status.is_success() && status.as_u16() != 302 {
        // IA returns 302 on successful login (redirect)
        return Err(format!("Login failed (HTTP {}): {}", status, body.chars().take(200).collect::<String>()));
    }

    // Verify login succeeded by checking a page that requires authentication
    let check = client
        .get("https://archive.org/details/tv")
        .send()
        .await
        .map_err(|e| format!("Login verification error: {}", e))?;

    // If we can access a page, login likely succeeded
    if check.status().is_success() || check.status().as_u16() == 302 {
        Ok(client)
    } else {
        Err(format!("Login failed: HTTP {}", check.status()))
    }
}

fn urlencoding(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' => c.to_string(),
            ' ' => "+".to_string(),
            _ => {
                let mut out = String::new();
                for b in c.to_string().bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
                out
            }
        })
        .collect()
}
