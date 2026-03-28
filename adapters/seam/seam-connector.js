/**
 * seam-connector.js
 * Seam Connector (Layer 7) — Stub
 *
 * Post-V1. Not implemented.
 * Mirrors the KisiConnector interface for future implementation.
 */

class SeamConnector {
  getHeaders(apiKey) {
    throw new Error('Seam connector not implemented');
  }

  async enforceRateLimit() {
    throw new Error('Seam connector not implemented');
  }

  async makeRequest(endpoint, options, apiKey, attempt = 1) {
    throw new Error('Seam connector not implemented');
  }
}

module.exports = new SeamConnector();
