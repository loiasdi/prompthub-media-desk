// Stable adapter errors; never include raw responses, URLs, credentials or upload tokens.
export class PublishError extends Error {
  constructor(code, message, { stage, platformCode, httpStatus, outcome = 'failed' } = {}) {
    super(message)
    this.name = 'PublishError'
    this.code = code
    this.stage = stage
    this.platformCode = platformCode
    this.httpStatus = httpStatus
    this.outcome = outcome
  }
}
