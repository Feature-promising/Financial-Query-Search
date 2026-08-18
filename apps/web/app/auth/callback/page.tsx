"use client";

import { useEffect, useState } from "react";
import { completeSignIn } from "../oidc-session";

export default function OidcCallbackPage() {
  const [error, setError] = useState<string>();
  useEffect(() => {
    void completeSignIn()
      .then((returnTo) => window.location.replace(returnTo))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "OIDC sign-in failed"));
  }, []);

  return <main className="workspace-shell auth-shell">
    <a className="brand" href="/"><span className="brand-mark" aria-hidden="true">R</span><span>Research<span className="brand-muted">/terminal</span></span></a>
    <section className="hero auth-hero">
      <div className="hero-copy">
        <p className="eyebrow">Secure workspace access</p>
        <h1>{error ? "登录未能完成。" : "正在安全连接你的研究工作台。"}</h1>
        <p className={`hero-description ${error ? "error" : ""}`}>{error ?? "正在处理企业身份提供商的授权响应，请稍候。"}</p>
        {error && <a className="auth-return" href="/">返回研究主页</a>}
      </div>
    </section>
  </main>;
}
