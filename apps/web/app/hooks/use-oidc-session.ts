"use client";

import { useCallback, useEffect, useState } from "react";
import { getOidcSessionState, oidcEnabled, signOut, startSignIn, type OidcSessionState } from "../auth/oidc-session";

const initialState: OidcSessionState = { enabled: false, authenticated: false };

export function useOidcSession() {
  const [state, setState] = useState<OidcSessionState>(initialState);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setState(await getOidcSessionState()); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return {
    ...state,
    loading,
    available: oidcEnabled(),
    signIn: () => startSignIn(),
    signOut: () => signOut(),
  };
}
