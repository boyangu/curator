// TLS for every Postgres connection that leaves this machine.
//
// postgres.js connects in the clear unless told otherwise, and Supabase's
// pooler accepts that, so a connection string alone decides nothing here: any
// host that is not this machine is connected to over TLS, with the
// certificate verified, whatever the string's `sslmode` says. Verified, not
// just encrypted: the driver's own 'require' skips the certificate check, and
// an unverified session can be read by whoever answers for the host.
//
// Supabase signs its database and pooler certificates with its own root, which
// no system store carries, so it travels with the code: the dashboard's
// download (Project Settings → Database → SSL Configuration), prod-ca-2021.crt.
// When Supabase moves to another root, add it here and release before the old
// one goes. Node's own roots stay trusted beside it for a host with a public
// certificate.
//
// The scripts under scripts/ connect by the same rule (scripts/cloud-pg.mjs
// loads this file).

import { rootCertificates } from 'node:tls';

// CN=Supabase Root 2021 CA, valid to 2031-04-26.
// SHA-256 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
const SUPABASE_ROOT_2021 = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`;

export const SUPABASE_ROOTS: readonly string[] = [SUPABASE_ROOT_2021];

// A database on this machine (a developer's own Postgres): nothing crosses a
// network, and it has no certificate to check.
export function isLocalDatabase(url: string): boolean {
	const host = new URL(url).hostname.toLowerCase();
	return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export type PostgresTls = { ssl?: { ca: string[]; rejectUnauthorized: true } };

// The driver options that carry the rule above, to spread into postgres()'s
// own. Empty for a local database, so its connection string keeps the say;
// for any other host an explicit `ssl` outranks the string's `sslmode`.
export function tlsOptions(url: string): PostgresTls {
	if (isLocalDatabase(url)) return {};
	return { ssl: { ca: [...rootCertificates, ...SUPABASE_ROOTS], rejectUnauthorized: true } };
}
