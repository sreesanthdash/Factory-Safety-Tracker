import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth.js";
import { LoadingMark, MotionButton } from "../motion.jsx";

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (loading) return <main className="loading-screen"><LoadingMark />Checking your session…</main>;
  if (user) return <Navigate to="/overview" replace />;

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login({ username, password });
      navigate(location.state?.from || "/overview", { replace: true });
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-layout">
      <section className="login-panel">
        <NavBrand />
        <div className="login-heading">
          <p className="section-context">Site access / local console</p>
          <h1>Good work starts with a clear view.</h1>
          <p>Sign in with your worker account to review safety signals for your site.</p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="username">Username</label>
          <input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck="false" required value={username} onChange={(event) => setUsername(event.target.value)} />
          <div className="label-line"><label htmlFor="password">Password</label><span>Use your assigned credentials</span></div>
          <input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          {error && <p className="form-error" role="alert">{error}</p>}
          <MotionButton className="button button--primary login-submit" type="submit" disabled={busy}>
            {busy ? "Checking access…" : "Sign in"}<span aria-hidden="true">↗</span>
          </MotionButton>
        </form>
        <p className="login-note"><span className="lock-mark" aria-hidden="true">⌑</span> Your session stays on this local demo.</p>
        <footer className="login-footer"><span>Site safety systems</span><span className="login-footer__credit">Made By Sreesanth &lt;3</span><span>Demo environment <i /></span></footer>
      </section>
      <aside className="login-aside" aria-label="Console information">
        <div className="aside-utility"><span><i /> Local prototype</span><span>Field note / 01</span></div>
        <div className="aside-content">
          <h2>Signals begin the conversation.<br /><span className="heading-second-line">People make the call.</span></h2>
          <p>Every detector alert remains a signal until a safety officer reviews it. This console keeps the source and the human decision visible together.</p>
          <div className="review-flow" aria-label="Review sequence">
            <div><span>01</span><b>Signal received</b><small>Automated; unconfirmed</small></div>
            <div><span>02</span><b>Worker acknowledgement</b><small>Access follows assigned role</small></div>
            <div><span>03</span><b>Safety review</b><small>Confirm or dismiss</small></div>
          </div>
        </div>
        <div className="aside-foot"><span>Designed for safer shifts</span><span>Shift handover / 01</span></div>
      </aside>
    </main>
  );
}

function NavBrand() {
  return <div className="login-brand"><span className="brand-copy"><strong>Site safety</strong><small>Operations console</small></span></div>;
}
