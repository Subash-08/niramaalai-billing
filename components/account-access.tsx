'use client';
import {useState, useEffect} from 'react';
import Link from 'next/link';
import {PageHead, Card, Field, Btn} from './ui';
import {useStore} from './store';

export default function AccountAccess() {
  const {isLive, companySession, refreshMasterData} = useStore();
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [loggedIn, setLoggedIn] = useState(isLive);
  const [form, setForm] = useState({
    name: '',
    companyName: '',
    email: '',
    password: '',
  });

  useEffect(() => {
    setLoggedIn(isLive);
  }, [isLive]);

  return (
    <>
      <PageHead
        title="Company account"
        description="Sign in to your approved company account to access its private billing records."
      />
      <div className="notice">
        {isLive ? (
          <span>
            Connected to live company account: <b>{companySession?.company?.name}</b> ({companySession?.user?.email}).
          </span>
        ) : (
          <span>
            Sign in to load and update your company’s live billing data.
          </span>
        )}
      </div>
      <Card title={loggedIn ? 'Account session' : signup ? 'Register your company' : 'Sign in'}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setMessage('');
            try {
              const response = await fetch('/api/auth/' + (signup ? 'signup' : 'login'), {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(signup ? form : {email: form.email, password: form.password}),
              });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || result.message || 'Request failed');
              if (signup) {
                setMessage('Account created. Awaiting administrator approval before first sign-in.');
              } else {
                setMessage('Signed in to ' + (result.user?.companyName || 'your company') + '. Master data loaded.');
                setLoggedIn(true);
                await refreshMasterData();
              }
              setForm((f) => ({...f, password: ''}));
            } catch (error) {
              setMessage(error instanceof Error ? error.message : 'Unable to reach backend');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-body form-grid">
            {loggedIn ? (
              <div className="full stack" style={{padding: '12px 0'}}>
                <p>
                  Signed in as <b>{companySession?.user?.name || 'Company User'}</b> (
                  {companySession?.user?.email || form.email})
                </p>
                <p className="muted">Company: {companySession?.company?.name || 'Your Company'}</p>
              </div>
            ) : (
              <>
                {signup && (
                  <>
                    <Field label="Company name">
                      <input
                        required
                        maxLength={120}
                        value={form.companyName}
                        onChange={(e) => setForm({...form, companyName: e.target.value})}
                      />
                    </Field>
                    <Field label="Your name">
                      <input
                        required
                        maxLength={100}
                        value={form.name}
                        onChange={(e) => setForm({...form, name: e.target.value})}
                      />
                    </Field>
                  </>
                )}
                <Field label="Email">
                  <input
                    required
                    type="email"
                    autoComplete="username"
                    value={form.email}
                    onChange={(e) => setForm({...form, email: e.target.value})}
                  />
                </Field>
                <Field label="Login password">
                  <input
                    required
                    type="password"
                    minLength={signup ? 12 : 1}
                    maxLength={128}
                    autoComplete={signup ? 'new-password' : 'current-password'}
                    value={form.password}
                    onChange={(e) => setForm({...form, password: e.target.value})}
                  />
                </Field>
              </>
            )}
            {message && (
              <p className="full notice" role="status">
                {message}
              </p>
            )}
          </div>
          <div className="form-actions">
            {loggedIn ? (
              <Btn
                secondary
                onClick={async () => {
                  const response = await fetch('/api/auth/logout', {method: 'POST'});
                  if (response.ok) {
                    await refreshMasterData();
                    setLoggedIn(false);
                    setMessage('Signed out.');
                  } else {
                    setMessage('Sign out failed. Try again.');
                  }
                }}
              >
                Sign out
              </Btn>
            ) : (
              <>
                <Btn
                  secondary
                  onClick={() => {
                    setSignup(!signup);
                    setMessage('');
                  }}
                >
                  {signup ? 'I already have an account' : 'Register company'}
                </Btn>
                <Btn type="submit" disabled={busy}>
                  {busy ? 'Please wait…' : signup ? 'Create pending account' : 'Sign in'}
                </Btn>
              </>
            )}
            {loggedIn && <Link className="btn secondary" href="/">Open dashboard</Link>}
          </div>
        </form>
      </Card>
    </>
  );
}
