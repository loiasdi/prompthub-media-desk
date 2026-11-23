export class MaitianError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.name = 'MaitianError'
    this.code = code
    this.status = status
  }
}

export const componentChanged = () => new MaitianError('COMPONENT_CHANGED', '麦田组件已更新或文件已变化，请重新检查并确认')

export function publicFailure(error) {
  return error instanceof MaitianError
    ? { code: error.code, message: error.message, status: error.status }
    : { code: 'COMPONENT_OPERATION_FAILED', message: '麦田组件操作失败，请检查组件与执行环境', status: 502 }
}
