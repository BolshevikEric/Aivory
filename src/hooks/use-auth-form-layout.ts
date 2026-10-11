import { createContext, useContext, useState } from 'react'

export const AuthFormLayoutContext = createContext({ compact: false, split: false, short: false })

/** Keep long forms in two steps when the auth panel has limited height. */
export function useAuthFormLayout() {
  const { compact, split, short } = useContext(AuthFormLayoutContext)
  const [passwordSelected, setPasswordSelected] = useState(false)
  return {
    compact,
    split,
    short,
    passwordStep: split && passwordSelected,
    showIdentity: !split || !passwordSelected,
    showPassword: !split || passwordSelected,
    setPasswordStep: setPasswordSelected,
  }
}
