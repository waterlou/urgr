use reqwest::cookie::Jar;
use reqwest::Url;
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct IaSession {
    pub client: reqwest::Client,
    pub cookies: IaCookies,
    pub s3_keys: S3Keys,
    pub screenname: String,
    pub email: String,
}

#[derive(Debug, Clone)]
pub struct IaCookies {
    pub logged_in_user: String,
    pub logged_in_sig: String,
}

#[derive(Debug, Clone)]
pub struct S3Keys {
    pub access: String,
    pub secret: String,
}

#[derive(Deserialize)]
struct XauthnResponse {
    success: bool,
    #[serde(default)]
    values: Option<XauthnValues>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct XauthnValues {
    cookies: XauthnCookies,
    s3: XauthnS3,
    screenname: String,
    email: String,
}

#[derive(Deserialize)]
struct XauthnCookies {
    #[serde(rename = "logged-in-user")]
    logged_in_user: String,
    #[serde(rename = "logged-in-sig")]
    logged_in_sig: String,
}

#[derive(Deserialize)]
struct XauthnS3 {
    access: String,
    secret: String,
}

pub async fn login(
    email: &str,
    password: &str,
) -> Result<IaSession, String> {
    let resp = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?
        .post("https://archive.org/services/xauthn/?op=login")
        .header("Accept", "application/json")
        .form(&[("email", email), ("password", password)])
        .send()
        .await
        .map_err(|e| format!("Login request error: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Failed to read response: {}", e))?;

    let xauthn: XauthnResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse login response (HTTP {}): {}", status, e))?;

    if !xauthn.success {
        let msg = xauthn.error.unwrap_or_else(|| "unknown error".into());
        let friendly = match msg.as_str() {
            "account_not_found" => "Account not found, check your email and try again.".into(),
            "account_bad_password" => "Incorrect password, try again.".into(),
            s => format!("Authentication failed: {}", s),
        };
        return Err(friendly);
    }

    let values = xauthn.values.ok_or("Missing values in login response")?;

    let logged_in_user = values.cookies.logged_in_user
        .split(';')
        .next()
        .unwrap_or(&values.cookies.logged_in_user)
        .to_string();

    let logged_in_sig = values.cookies.logged_in_sig
        .split(';')
        .next()
        .unwrap_or(&values.cookies.logged_in_sig)
        .to_string();

    let cookies = IaCookies {
        logged_in_user,
        logged_in_sig,
    };

    let s3_keys = S3Keys {
        access: values.s3.access,
        secret: values.s3.secret,
    };

    // Build a cookie jar with the auth cookies
    let cookie_jar = Jar::default();
    let base_url: Url = "https://archive.org".parse().unwrap();

    cookie_jar.add_cookie_str(
        &format!("logged-in-user={}; domain=.archive.org; path=/", cookies.logged_in_user),
        &base_url,
    );
    cookie_jar.add_cookie_str(
        &format!("logged-in-sig={}; domain=.archive.org; path=/", cookies.logged_in_sig),
        &base_url,
    );

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .cookie_provider(Arc::new(cookie_jar))
        .build()
        .map_err(|e| format!("Failed to build authenticated client: {}", e))?;

    Ok(IaSession {
        client,
        cookies,
        s3_keys,
        screenname: values.screenname,
        email: values.email,
    })
}
