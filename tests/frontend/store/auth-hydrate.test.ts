import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiAuthPolicy, ApiUser } from '@/api/types'

const apiMocks = vi.hoisted(() => ({
  session: vi.fn(),
  register: vi.fn(),
  authPolicy: vi.fn(),
  signupOpen: vi.fn(),
  needsSetup: vi.fn(),
  logout: vi.fn(),
}))

const clientMocks = vi.hoisted(() => ({
  setAccessToken: vi.fn(),
  resetAuthFailureState: vi.fn(),
}))

vi.mock('@/api', () => ({
  authApi: apiMocks,
  ApiError: class ApiError extends Error {
    constructor(_status: number, message: string) { super(message) }
  },
  setAccessToken: clientMocks.setAccessToken,
  resetAuthFailureState: clientMocks.resetAuthFailureState,
}))

vi.mock('@/api/client', () => ({
  invalidateAccountRequests: vi.fn(),
  isAuthRefreshSuppressed: () => false,
  setAuthLostHandler: vi.fn(),
  setBannedHandler: vi.fn(),
  setInitialPasswordRequiredHandler: vi.fn(),
  setRefreshHandler: vi.fn(),
}))

import { ApiError } from '@/api'
import { DEFAULT_AUTH_POLICY, useAuth } from '@/store/auth'

const policy: ApiAuthPolicy = {
  password_login_enabled: false,
  entry_mode: 'provider_picker',
  default_provider: null,
  oauth_initial_password_policy: 'optional',
  oauth_auto_provision_enabled: true,
  providers: [],
}

const user = {
  id: 'user-1',
  email: 'user@example.test',
  name: 'User',
  role: 'user',
  status: 'active',
  settings: {},
  created_at: 1,
} as ApiUser

describe('auth startup request coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuth.setState({
      user: null,
      status: 'idle',
      authPolicy: DEFAULT_AUTH_POLICY,
      authPolicyLoaded: false,
      signupOpen: true,
      captchaRequired: false,
      loginCaptchaRequired: false,
      needsSetup: false,
      setupProbed: false,
      error: null,
      banned: false,
    })
    apiMocks.authPolicy.mockResolvedValue(policy)
    apiMocks.signupOpen.mockResolvedValue({ open: true, captcha_required: false, login_captcha_required: false })
    apiMocks.needsSetup.mockResolvedValue({ needs_setup: false })
    apiMocks.logout.mockResolvedValue({ ok: true })
  })

  it('keeps a suspension through a signed-out probe and clears it when switching accounts', async () => {
    useAuth.setState({ user, pendingTwoFactor: { ticket: 'old-ticket' }, pendingVerification: 'old@example.test' })
    useAuth.getState().markSuspended()
    expect(useAuth.getState()).toMatchObject({ user: null, banned: true, error: null, pendingTwoFactor: null, pendingVerification: null })
    apiMocks.session.mockResolvedValue({ authenticated: false, auth_policy: policy })
    await useAuth.getState().hydrate()
    expect(useAuth.getState().banned).toBe(true)
    await useAuth.getState().logout()
    expect(apiMocks.logout).toHaveBeenCalledOnce()
    expect(useAuth.getState()).toMatchObject({ user: null, banned: false, error: null, status: 'unauthenticated' })
  })

  it('clears a stale suspension when a valid session or verified account is restored', async () => {
    useAuth.getState().markSuspended()
    apiMocks.session.mockResolvedValue({ authenticated: true, user, access_token: 'access-token', request_signing_key: 'signing-key', auth_policy: policy })
    await useAuth.getState().hydrate()
    expect(useAuth.getState()).toMatchObject({ user, banned: false, status: 'authenticated' })
    useAuth.getState().markSuspended()
    useAuth.getState().setUser(user)
    expect(useAuth.getState()).toMatchObject({ user, banned: false, status: 'authenticated' })
  })

  it('uses the policy embedded in an authenticated session without public probes', async () => {
    apiMocks.session.mockResolvedValue({
      authenticated: true,
      user,
      access_token: 'access-token',
      request_signing_key: 'request-signing-key',
      expires_at: 2,
      auth_policy: policy,
    })

    await useAuth.getState().hydrate()

    expect(apiMocks.session).toHaveBeenCalledOnce()
    expect(apiMocks.authPolicy).not.toHaveBeenCalled()
    expect(apiMocks.signupOpen).not.toHaveBeenCalled()
    expect(apiMocks.needsSetup).not.toHaveBeenCalled()
    expect(clientMocks.setAccessToken).toHaveBeenCalledWith('access-token', 'request-signing-key')
    expect(useAuth.getState()).toMatchObject({
      user,
      status: 'authenticated',
      authPolicy: policy,
      authPolicyLoaded: true,
      setupProbed: true,
    })
  })

  it('runs only the setup and signup probes after a signed-out session', async () => {
    apiMocks.session.mockResolvedValue({ authenticated: false, auth_policy: policy })

    await useAuth.getState().hydrate()

    expect(apiMocks.authPolicy).not.toHaveBeenCalled()
    expect(apiMocks.signupOpen).toHaveBeenCalledOnce()
    expect(apiMocks.needsSetup).toHaveBeenCalledOnce()
    expect(useAuth.getState()).toMatchObject({
      status: 'unauthenticated',
      authPolicy: policy,
      authPolicyLoaded: true,
      setupProbed: true,
    })
  })

  it('falls back to the standalone policy endpoint during a rolling upgrade', async () => {
    apiMocks.session.mockResolvedValue({ authenticated: true, user, access_token: 'access-token', expires_at: 2 })

    await useAuth.getState().hydrate()

    expect(apiMocks.authPolicy).toHaveBeenCalledOnce()
    expect(useAuth.getState().authPolicy).toEqual(policy)
  })
})


describe('registration captcha policy recovery', () => {
  it('requires a puzzle after the server rejects a stale no-captcha policy', async () => {
    useAuth.setState({ captchaRequired: false, user: null, status: 'unauthenticated' })
    apiMocks.register.mockRejectedValueOnce(new ApiError(400, 'captcha_failed', undefined))
    await expect(useAuth.getState().register('user@example.test', 'password123', 'User')).resolves.toBe(false)
    expect(useAuth.getState().captchaRequired).toBe(true)
    expect(useAuth.getState().error).toBe('captcha_failed')

    apiMocks.register.mockResolvedValueOnce({ verification_required: true, email: 'user@example.test', retry_after: 60 })
    await expect(useAuth.getState().register('user@example.test', 'password123', 'User', 'fresh-pass')).resolves.toBe('verify')
    expect(apiMocks.register).toHaveBeenLastCalledWith('user@example.test', 'password123', 'User', 'fresh-pass')
  })
})
