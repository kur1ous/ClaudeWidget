import type { WidgetApi } from '../shared/types'

declare global {
  interface Window {
    widget: WidgetApi
  }
}

export {}
