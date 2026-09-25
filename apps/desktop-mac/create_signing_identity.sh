#!/bin/zsh
# Creates the stable self-signed code-signing identity Flint.app is signed with.
# Idempotent: does nothing if it already exists. install_app.sh runs it.
#
# Why: macOS keys privacy grants (the microphone, for voice) to the code
# signature. An ad-hoc signature changes with every build, so each update asked
# for the mic again. One stable identity means the grant is given once.
#
# Needs no admin rights and adds no trusted root. Nobody verifies the
# certificate; codesign only needs its private key, which is why
# `security find-identity -p codesigning` does not list it while
# `codesign --sign` accepts it.
set -eu
IDENTITY="${FLINT_SIGN_IDENTITY:-Flint Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/req.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $IDENTITY
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/req.cnf" 2>/dev/null
# OpenSSL 3 (Homebrew's, first on PATH) defaults to a PKCS#12 format that
# `security import` cannot verify ("MAC verification failed"). Ask for the
# SHA-1/3DES format macOS reads; Apple's LibreSSL takes the same flags.
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/bundle.p12" -passout pass:flint -name "$IDENTITY" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 2>/dev/null

# No prompt on use: auto_deploy signs from launchd, where a keychain dialog has
# no window to appear in and would hang the tick. Same flags as Helm's, which
# sign under launchd without one. The key signs nothing but local builds.
security import "$WORK/bundle.p12" -k "$KEYCHAIN" -P flint \
  -T /usr/bin/codesign -T /usr/bin/security -A >/dev/null

security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1 || {
  echo "error: imported '$IDENTITY' but cannot find it in the login keychain" >&2
  exit 1
}
echo "created '$IDENTITY' in the login keychain"
