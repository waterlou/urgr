use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct RateLimiter {
    interval: Duration,
    last: Mutex<Instant>,
}

impl RateLimiter {
    pub fn new(requests_per_second: f64) -> Self {
        let interval = if requests_per_second <= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(1.0 / requests_per_second)
        };
        Self {
            interval,
            last: Mutex::new(Instant::now()),
        }
    }

    pub async fn acquire(&self) {
        if self.interval.is_zero() {
            return;
        }
        let mut last = self.last.lock().await;
        let elapsed = last.elapsed();
        if elapsed < self.interval {
            let wait = self.interval - elapsed;
            tokio::time::sleep(wait).await;
        }
        *last = Instant::now();
    }
}
