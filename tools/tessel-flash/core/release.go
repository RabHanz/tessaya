package core

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

const (
	IndexURL = "https://github.com/RabHanz/tessaya/releases/download/r1-firmware-index/r1-releases.json"
	// ReleasePublicKey is the R1 release key's public half (secp256r1, uncompressed), as compiled into the firmware
	// and R1_FIRMWARE_PUBLIC_KEY in packages/baton-shared/src/r1Firmware.ts.
	ReleasePublicKey = "044a630e15eaf9f58558dbbd8f9519c26349b80e7c94110f159c92824c3470ea16e6aa5da0ee9dc560a62bfbe3b6710d2268855d27a785dfbb040d1b8158c32a14"
)

type Artifact struct {
	URL    string `json:"url"`
	Size   int    `json:"size"`
	SHA256 string `json:"sha256"`
	Sig    string `json:"sig"`
}

type Release struct {
	Version string    `json:"version"`
	Date    string    `json:"date"`
	RBL     *Artifact `json:"rbl"`
	AllApp  *Artifact `json:"allapp"`
}

type Index struct {
	V           int       `json:"v"`
	Recommended string    `json:"recommended"`
	Releases    []Release `json:"releases"`
}

func ParsePublicKey(h string) (*ecdsa.PublicKey, error) {
	b, err := hex.DecodeString(h)
	if err != nil {
		return nil, err
	}
	return ecdsa.ParseUncompressedPublicKey(elliptic.P256(), b)
}

// VerifySig checks a release signature: ECDSA P-256 with SHA-256 over the bytes, as raw r||s in hex.
func VerifySig(pub *ecdsa.PublicKey, data []byte, sigHex string) bool {
	sig, err := hex.DecodeString(strings.TrimSpace(sigHex))
	if err != nil || len(sig) != 64 {
		return false
	}
	h := sha256.Sum256(data)
	return ecdsa.Verify(pub, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

// ParseIndex verifies the release list's signature before reading it, so a version label can't be moved onto
// another signed image.
func ParseIndex(body []byte, sigHex string, pub *ecdsa.PublicKey) (*Index, error) {
	if !VerifySig(pub, body, sigHex) {
		return nil, refuse("refusing: the release list is not signed by the release key")
	}
	var ix Index
	if err := json.Unmarshal(body, &ix); err != nil {
		return nil, fmt.Errorf("release list: %w", err)
	}
	if ix.V != 1 {
		return nil, fmt.Errorf("release list version %d is newer than this tessel-flash; update it", ix.V)
	}
	return &ix, nil
}

// CableImage is the release's signed cable image; "" means the recommended one.
func (ix *Index) CableImage(version string) (*Release, error) {
	if version == "" {
		version = ix.Recommended
	}
	for i := range ix.Releases {
		r := &ix.Releases[i]
		if r.Version == version {
			if r.AllApp == nil {
				return nil, refuse("refusing: %s has no cable image", version)
			}
			return r, nil
		}
	}
	return nil, refuse("refusing: no signed release %s", version)
}

// CheckArtifact checks size, sha256 and signature of a downloaded image.
func CheckArtifact(data []byte, a *Artifact, pub *ecdsa.PublicKey) error {
	h := sha256.Sum256(data)
	if len(data) != a.Size || hex.EncodeToString(h[:]) != strings.ToLower(a.SHA256) {
		return refuse("refusing: the image does not match its release (size or sha256)")
	}
	if !VerifySig(pub, data, a.Sig) {
		return refuse("refusing: the image is not signed by the release key")
	}
	return nil
}
