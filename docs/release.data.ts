// 构建时调用 GitHub Releases API，获取最新版本信息
// VitePress Data Loader：构建阶段执行，数据静态嵌入页面

export interface ReleaseData {
  /** 版本号，如 v1.0.0 */
  version: string
  /** 发布时间 ISO 字符串 */
  publishedAt: string
  /** Release body（changelog markdown） */
  body: string
  /** zip 下载直链 */
  downloadUrl: string
  /** zip 文件大小（字节） */
  downloadSize: number
  /** GitHub Release 页面链接 */
  htmlUrl: string
  /** 是否存在 release */
  hasRelease: boolean
}

declare const data: ReleaseData
export { data }

export default {
  async load(): Promise<ReleaseData> {
    const REPO = 'clark-maybe/mole-extension'
    const API = `https://api.github.com/repos/${REPO}/releases/latest`
    // 固定下载地址，不跟版本号
    const DOWNLOAD_URL = `https://github.com/${REPO}/releases/download/release/mole-extension.zip`

    try {
      const res = await fetch(API, {
        headers: { Accept: 'application/vnd.github.v3+json' },
      })
      if (!res.ok) throw new Error(`GitHub API: ${res.status}`)

      const release = await res.json()
      const asset = release.assets?.find((a: { name: string }) =>
        a.name.endsWith('.zip'),
      )

      return {
        version: release.tag_name ?? '',
        publishedAt: release.published_at ?? '',
        body: release.body ?? '',
        downloadUrl: DOWNLOAD_URL,
        downloadSize: asset?.size ?? 0,
        htmlUrl: release.html_url ?? '',
        hasRelease: true,
      }
    } catch {
      // 尚无 release 或 API 异常，返回空数据
      return {
        version: '',
        publishedAt: '',
        body: '',
        downloadUrl: '',
        downloadSize: 0,
        htmlUrl: '',
        hasRelease: false,
      }
    }
  },
}
