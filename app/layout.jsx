import "./globals.css";

export const metadata = {
  title: "Towwatch 双人同步观影",
  description: "双人同步观影、视频源搜索、选集播放和实时聊天。"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
