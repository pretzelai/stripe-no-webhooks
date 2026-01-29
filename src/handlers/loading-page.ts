/**
 * Generate a minimal loading page that polls for checkout status.
 */
export function generateLoadingPage(
  sessionId: string,
  redirectUrl: string,
  timeoutMs: number,
  statusEndpoint: string
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Processing Payment...</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #f5f5f5;
      color: #333;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 4px solid #e0e0e0;
      border-top-color: #635bff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1.5rem;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    p {
      color: #666;
      font-size: 0.95rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h1>Processing your payment...</h1>
    <p>Please wait while we confirm your subscription.</p>
  </div>
  <script>
    (function() {
      const sessionId = ${JSON.stringify(sessionId)};
      const redirectUrl = ${JSON.stringify(redirectUrl)};
      const timeoutMs = ${timeoutMs};
      const statusEndpoint = ${JSON.stringify(statusEndpoint)};
      const pollInterval = 1000;
      const startTime = Date.now();

      function poll() {
        if (Date.now() - startTime > timeoutMs) {
          window.location.href = redirectUrl;
          return;
        }

        fetch(statusEndpoint + '?session_id=' + encodeURIComponent(sessionId))
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data.status === 'ready') {
              window.location.href = redirectUrl;
            } else {
              setTimeout(poll, pollInterval);
            }
          })
          .catch(function() {
            setTimeout(poll, pollInterval);
          });
      }

      poll();
    })();
  </script>
</body>
</html>`;
}
