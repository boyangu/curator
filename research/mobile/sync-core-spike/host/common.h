// What both hosts (host.c for QuickJS, host-hermes.cpp for Hermes) do the
// same way, with no engine in it: SHA-1 and SHA-256, the UTF-8 better-sqlite3
// writes, files, gzip, one HTTP request, clocks and memory figures. Plain C
// that also compiles as C++; a failure comes back as a message for the
// caller to throw in its engine's own way.

#ifndef SPIKE_HOST_COMMON_H
#define SPIKE_HOST_COMMON_H

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#ifdef SPIKE_ZLIB
#include <zlib.h>
#endif

// ── SHA-1 ────────────────────────────────────────────────────────────────────

typedef struct { uint32_t h[5]; uint64_t len; uint8_t buf[64]; size_t n; } Sha1;

static void sha1_block(Sha1 *s, const uint8_t *p) {
	uint32_t w[80], a, b, c, d, e, t;
	int i;
	for (i = 0; i < 16; i++) w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
	for (i = 16; i < 80; i++) { t = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = t << 1 | t >> 31; }
	a = s->h[0]; b = s->h[1]; c = s->h[2]; d = s->h[3]; e = s->h[4];
	for (i = 0; i < 80; i++) {
		uint32_t f, k;
		if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
		else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
		else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
		else { f = b ^ c ^ d; k = 0xCA62C1D6; }
		t = (a << 5 | a >> 27) + f + e + k + w[i];
		e = d; d = c; c = b << 30 | b >> 2; b = a; a = t;
	}
	s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d; s->h[4] += e;
}

static void sha1_init(Sha1 *s) {
	s->h[0] = 0x67452301; s->h[1] = 0xEFCDAB89; s->h[2] = 0x98BADCFE; s->h[3] = 0x10325476; s->h[4] = 0xC3D2E1F0;
	s->len = 0; s->n = 0;
}

static void sha1_update(Sha1 *s, const uint8_t *p, size_t len) {
	s->len += len;
	while (len > 0) {
		if (s->n == 0 && len >= 64) { sha1_block(s, p); p += 64; len -= 64; continue; }
		size_t take = 64 - s->n < len ? 64 - s->n : len;
		memcpy(s->buf + s->n, p, take);
		s->n += take; p += take; len -= take;
		if (s->n == 64) { sha1_block(s, s->buf); s->n = 0; }
	}
}

static void sha1_final(Sha1 *s, uint8_t out[20]) {
	uint64_t bits = s->len * 8;
	uint8_t pad = 0x80, zero = 0, lenb[8];
	int i;
	sha1_update(s, &pad, 1);
	while (s->n != 56) sha1_update(s, &zero, 1);
	for (i = 0; i < 8; i++) lenb[i] = (uint8_t)(bits >> (56 - 8 * i));
	sha1_update(s, lenb, 8);
	for (i = 0; i < 5; i++) { out[4 * i] = s->h[i] >> 24; out[4 * i + 1] = s->h[i] >> 16; out[4 * i + 2] = s->h[i] >> 8; out[4 * i + 3] = s->h[i]; }
}

// ── SHA-256 ──────────────────────────────────────────────────────────────────

typedef struct { uint32_t h[8]; uint64_t len; uint8_t buf[64]; size_t n; } Sha256;

static const uint32_t K256[64] = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define ROR(x, n) ((x) >> (n) | (x) << (32 - (n)))

static void sha256_block(Sha256 *s, const uint8_t *p) {
	uint32_t w[64], v[8], t1, t2;
	int i;
	for (i = 0; i < 16; i++) w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
	for (i = 16; i < 64; i++) w[i] = (ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ w[i - 2] >> 10) + w[i - 7] + (ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ w[i - 15] >> 3) + w[i - 16];
	memcpy(v, s->h, sizeof v);
	for (i = 0; i < 64; i++) {
		t1 = v[7] + (ROR(v[4], 6) ^ ROR(v[4], 11) ^ ROR(v[4], 25)) + ((v[4] & v[5]) ^ (~v[4] & v[6])) + K256[i] + w[i];
		t2 = (ROR(v[0], 2) ^ ROR(v[0], 13) ^ ROR(v[0], 22)) + ((v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]));
		v[7] = v[6]; v[6] = v[5]; v[5] = v[4]; v[4] = v[3] + t1; v[3] = v[2]; v[2] = v[1]; v[1] = v[0]; v[0] = t1 + t2;
	}
	for (i = 0; i < 8; i++) s->h[i] += v[i];
}

static void sha256_init(Sha256 *s) {
	static const uint32_t h0[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
	memcpy(s->h, h0, sizeof h0);
	s->len = 0; s->n = 0;
}

static void sha256_update(Sha256 *s, const uint8_t *p, size_t len) {
	s->len += len;
	while (len > 0) {
		if (s->n == 0 && len >= 64) { sha256_block(s, p); p += 64; len -= 64; continue; }
		size_t take = 64 - s->n < len ? 64 - s->n : len;
		memcpy(s->buf + s->n, p, take);
		s->n += take; p += take; len -= take;
		if (s->n == 64) { sha256_block(s, s->buf); s->n = 0; }
	}
}

static void sha256_final(Sha256 *s, uint8_t out[32]) {
	uint64_t bits = s->len * 8;
	uint8_t pad = 0x80, zero = 0, lenb[8];
	int i;
	sha256_update(s, &pad, 1);
	while (s->n != 56) sha256_update(s, &zero, 1);
	for (i = 0; i < 8; i++) lenb[i] = (uint8_t)(bits >> (56 - 8 * i));
	sha256_update(s, lenb, 8);
	for (i = 0; i < 8; i++) { out[4 * i] = s->h[i] >> 24; out[4 * i + 1] = s->h[i] >> 16; out[4 * i + 2] = s->h[i] >> 8; out[4 * i + 3] = s->h[i]; }
}

// SHA-1 (bits 160) or SHA-256 (256), fed a part at a time.
typedef struct { bool wide; Sha1 s1; Sha256 s2; } Hasher;

static void hasher_init(Hasher *h, int bits) {
	h->wide = bits == 256;
	if (h->wide) sha256_init(&h->s2); else sha1_init(&h->s1);
}

static void hasher_update(Hasher *h, const uint8_t *p, size_t len) {
	if (h->wide) sha256_update(&h->s2, p, len); else sha1_update(&h->s1, p, len);
}

// -> the digest's size in bytes.
static size_t hasher_final(Hasher *h, uint8_t out[32]) {
	if (h->wide) { sha256_final(&h->s2, out); return 32; }
	sha1_final(&h->s1, out);
	return 20;
}

static void hex_of(const uint8_t *p, size_t n, char *out) {
	static const char digits[] = "0123456789abcdef";
	for (size_t i = 0; i < n; i++) { out[2 * i] = digits[p[i] >> 4]; out[2 * i + 1] = digits[p[i] & 15]; }
	out[2 * n] = 0;
}

// ── text ─────────────────────────────────────────────────────────────────────

// An engine may write a lone surrogate as its three-byte form (ED A0..BF xx);
// V8, and so better-sqlite3 and node:crypto, write U+FFFD. Returns `p` itself
// when the string holds none, else a malloc'd copy the caller frees.
static const char *utf8_like_v8(const char *p, size_t len, char **owned) {
	*owned = NULL;
	const char *q = (const char *)memchr(p, 0xED, len);
	while (q && !(q + 1 < p + len && ((uint8_t)q[1] & 0xE0) == 0xA0)) q = (const char *)memchr(q + 1, 0xED, (size_t)(p + len - q - 1));
	if (!q) return p;
	char *out = (char *)malloc(len + 1);
	memcpy(out, p, len);
	out[len] = 0;
	for (size_t i = 0; i + 2 < len; i++) {
		if ((uint8_t)out[i] == 0xED && ((uint8_t)out[i + 1] & 0xE0) == 0xA0) { out[i] = (char)0xEF; out[i + 1] = (char)0xBF; out[i + 2] = (char)0xBD; i += 2; }
	}
	*owned = out;
	return out;
}

// Whether anything but whitespace, `;` and comments follows a statement.
static bool has_more_sql(const char *p) {
	for (;;) {
		while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == '\f' || *p == ';') p++;
		if (p[0] == '-' && p[1] == '-') { while (*p && *p != '\n') p++; continue; }
		if (p[0] == '/' && p[1] == '*') { p += 2; while (*p && !(p[0] == '*' && p[1] == '/')) p++; if (*p) p += 2; continue; }
		return *p != 0;
	}
}

// ── files ────────────────────────────────────────────────────────────────────

// The whole file, NUL-terminated (not counted in *len); NULL with `err` set.
static uint8_t *read_file(const char *path, size_t *len, char *err, size_t errlen) {
	FILE *f = fopen(path, "rb");
	if (!f) { snprintf(err, errlen, "cannot open %s: %s", path, strerror(errno)); return NULL; }
	fseeko(f, 0, SEEK_END);
	off_t size = ftello(f);
	fseeko(f, 0, SEEK_SET);
	uint8_t *buf = (uint8_t *)malloc((size_t)size + 1);
	if (!buf || fread(buf, 1, (size_t)size, f) != (size_t)size) {
		fclose(f);
		free(buf);
		snprintf(err, errlen, "cannot read %s (%lld bytes)", path, (long long)size);
		return NULL;
	}
	fclose(f);
	buf[size] = 0;
	*len = (size_t)size;
	return buf;
}

// A path's size in bytes, or -1 when nothing is there.
static long long file_size(const char *path) {
	FILE *f = fopen(path, "rb");
	if (!f) return -1;
	fseeko(f, 0, SEEK_END);
	long long n = (long long)ftello(f);
	fclose(f);
	return n;
}

static bool rename_file(const char *from, const char *to, char *err, size_t errlen) {
	if (rename(from, to) == 0) return true;
	snprintf(err, errlen, "cannot rename %s to %s: %s", from, to, strerror(errno));
	return false;
}

// Gone already is fine.
static bool remove_file(const char *path, char *err, size_t errlen) {
	if (remove(path) == 0 || errno == ENOENT) return true;
	snprintf(err, errlen, "cannot remove %s: %s", path, strerror(errno));
	return false;
}

// `append`: add to the end of the file instead of replacing it.
static bool write_file_mode(const char *path, const void *data, size_t len, bool append, char *err, size_t errlen) {
	FILE *f = fopen(path, append ? "ab" : "wb");
	bool ok = f && fwrite(data, 1, len, f) == len;
	if (f && fclose(f) != 0) ok = false;
	if (!ok) snprintf(err, errlen, "cannot write %s: %s", path, strerror(errno));
	return ok;
}

static bool write_file(const char *path, const char *text, size_t len, char *err, size_t errlen) {
	FILE *f = fopen(path, "wb");
	bool ok = f && fwrite(text, 1, len, f) == len;
	if (f) fclose(f);
	if (!ok) snprintf(err, errlen, "cannot write %s: %s", path, strerror(errno));
	return ok;
}

// ── gzip ─────────────────────────────────────────────────────────────────────

// A gzip body inflated a piece at a time: the snapshot's text is a quarter of
// a gigabyte and is never held whole.
typedef struct {
#ifdef SPIKE_ZLIB
	z_stream z;
#endif
	uint8_t *in;
	bool done;
} InflateStream;

static InflateStream *inflate_open(const uint8_t *in, size_t len, char *err, size_t errlen) {
#ifdef SPIKE_ZLIB
	InflateStream *s = (InflateStream *)calloc(1, sizeof *s);
	s->in = (uint8_t *)malloc(len ? len : 1);
	memcpy(s->in, in, len);
	if (inflateInit2(&s->z, 16 + MAX_WBITS) != Z_OK) { free(s->in); free(s); snprintf(err, errlen, "inflateInit2 failed"); return NULL; }
	s->z.next_in = s->in;
	s->z.avail_in = (uInt)len;
	return s;
#else
	(void)in; (void)len;
	snprintf(err, errlen, "this host was built without zlib");
	return NULL;
#endif
}

// -> up to `max` inflated bytes (malloc'd, *n of them); NULL with *n 0 once
// the body is out; NULL with `err` set on a bad body.
static uint8_t *inflate_read(InflateStream *s, size_t max, size_t *n, char *err, size_t errlen) {
	*n = 0;
	err[0] = 0;
#ifdef SPIKE_ZLIB
	if (s->done) return NULL;
	uint8_t *out = (uint8_t *)malloc(max);
	s->z.next_out = out;
	s->z.avail_out = (uInt)max;
	while (s->z.avail_out > 0 && !s->done) {
		int rc = inflate(&s->z, Z_NO_FLUSH);
		if (rc == Z_STREAM_END) s->done = true;
		else if (rc != Z_OK || (s->z.avail_in == 0 && s->z.avail_out > 0)) { free(out); snprintf(err, errlen, "inflate failed (%d)", rc); return NULL; }
	}
	*n = max - s->z.avail_out;
	if (*n == 0) { free(out); return NULL; }
	return (uint8_t *)realloc(out, *n);
#else
	(void)s; (void)max;
	snprintf(err, errlen, "this host was built without zlib");
	return NULL;
#endif
}

static void inflate_close(InflateStream *s) {
#ifdef SPIKE_ZLIB
	inflateEnd(&s->z);
#endif
	free(s->in);
	free(s);
}

// A whole gzip body inflated (malloc'd, *n bytes); NULL with `err` set.
static uint8_t *gunzip_all(const uint8_t *in, size_t len, size_t *n, char *err, size_t errlen) {
#ifdef SPIKE_ZLIB
	z_stream z;
	memset(&z, 0, sizeof z);
	if (inflateInit2(&z, 16 + MAX_WBITS) != Z_OK) { snprintf(err, errlen, "inflateInit2 failed"); return NULL; }
	size_t cap = len * 6 + 65536;
	*n = 0;
	uint8_t *out = (uint8_t *)malloc(cap);
	z.next_in = (Bytef *)in;
	z.avail_in = (uInt)len;
	int rc = Z_OK;
	while (rc != Z_STREAM_END) {
		if (*n == cap) { cap += cap / 2; out = (uint8_t *)realloc(out, cap); }
		size_t room = cap - *n;
		z.next_out = out + *n;
		z.avail_out = room > 0x40000000 ? 0x40000000 : (uInt)room;
		uInt gave = z.avail_out;
		rc = inflate(&z, Z_NO_FLUSH);
		*n += gave - z.avail_out;
		if (rc != Z_OK && rc != Z_STREAM_END) { inflateEnd(&z); free(out); snprintf(err, errlen, "inflate failed (%d)", rc); return NULL; }
	}
	inflateEnd(&z);
	return (uint8_t *)realloc(out, *n ? *n : 1);
#else
	(void)in; (void)len; (void)n;
	snprintf(err, errlen, "this host was built without zlib");
	return NULL;
#endif
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

// The answer: `buf` holds all of it (the caller frees it), `body` points
// into it past the headers.
typedef struct { int status; uint8_t *buf; uint8_t *body; size_t body_len; } HttpAnswer;

// One HTTP/1.1 request over a plain socket, the connection closed after it.
// For the test server on this machine (through `adb reverse` on a phone); a
// real app's HTTP is the platform's, with TLS. False with `err` set.
static bool http_request(const char *method, const char *host, int port, const char *path, const char *lines,
                         const char *body, size_t body_len, HttpAnswer *out, char *err, size_t errlen) {
	memset(out, 0, sizeof *out);
	char service[16];
	snprintf(service, sizeof service, "%d", port);
	struct addrinfo hints, *found = NULL;
	memset(&hints, 0, sizeof hints);
	hints.ai_socktype = SOCK_STREAM;
	if (getaddrinfo(host, service, &hints, &found) != 0 || !found) { snprintf(err, errlen, "cannot resolve %s", host); return false; }
	int fd = -1;
	for (struct addrinfo *a = found; a && fd < 0; a = a->ai_next) {
		fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
		if (fd >= 0 && connect(fd, a->ai_addr, a->ai_addrlen) != 0) { close(fd); fd = -1; }
	}
	freeaddrinfo(found);
	if (fd < 0) { snprintf(err, errlen, "cannot connect to %s:%d: %s", host, port, strerror(errno)); return false; }

	size_t head_cap = strlen(method) + strlen(path) + strlen(host) + strlen(lines) + 128;
	char *head = (char *)malloc(head_cap);
	int head_len = snprintf(head, head_cap, "%s %s HTTP/1.1\r\nHost: %s:%d\r\nConnection: close\r\n%sContent-Length: %zu\r\n\r\n", method, path, host, port, lines, body_len);
	bool sent = true;
	for (size_t off = 0; sent && off < (size_t)head_len;) { ssize_t n = send(fd, head + off, (size_t)head_len - off, 0); if (n <= 0) sent = false; else off += (size_t)n; }
	for (size_t off = 0; sent && off < body_len;) { ssize_t n = send(fd, body + off, body_len - off, 0); if (n <= 0) sent = false; else off += (size_t)n; }
	free(head);
	if (!sent) { snprintf(err, errlen, "the request to %s:%d was cut: %s", host, port, strerror(errno)); close(fd); return false; }

	size_t cap = 1 << 16, len = 0;
	uint8_t *buf = (uint8_t *)malloc(cap);
	for (;;) {
		if (len == cap) { cap *= 2; buf = (uint8_t *)realloc(buf, cap); }
		ssize_t n = recv(fd, buf + len, cap - len, 0);
		if (n < 0) { snprintf(err, errlen, "the answer from %s:%d was cut: %s", host, port, strerror(errno)); close(fd); free(buf); return false; }
		if (n == 0) break;
		len += (size_t)n;
	}
	close(fd);
	// "HTTP/1.1 200 …", headers, a blank line, the body.
	uint8_t *split = len >= 4 ? (uint8_t *)memmem(buf, len, "\r\n\r\n", 4) : NULL;
	int status = 0;
	if (!split || len < 12 || sscanf((const char *)buf, "HTTP/%*d.%*d %d", &status) != 1) { snprintf(err, errlen, "not an HTTP answer from %s:%d", host, port); free(buf); return false; }
	size_t head_bytes = (size_t)(split - buf) + 4;
	uint8_t *payload = buf + head_bytes;
	size_t payload_len = len - head_bytes;
	// A chunked body (no Content-Length from the server): the chunks joined in place.
	*split = 0;
	bool chunked = false;
	for (char *p = (char *)buf; *p; p++) if (strncasecmp(p, "transfer-encoding: chunked", 26) == 0) { chunked = true; break; }
	if (chunked) {
		size_t r = 0, w = 0;
		while (r < payload_len) {
			size_t size = strtoul((const char *)payload + r, NULL, 16);
			uint8_t *eol = (uint8_t *)memmem(payload + r, payload_len - r, "\r\n", 2);
			if (!eol || size == 0) break;
			r = (size_t)(eol - payload) + 2;
			if (r + size > payload_len) break;
			memmove(payload + w, payload + r, size);
			w += size;
			r += size + 2;
		}
		payload_len = w;
	}
	out->status = status;
	out->buf = buf;
	out->body = payload;
	out->body_len = payload_len;
	return true;
}

// ── clocks, ids, memory ──────────────────────────────────────────────────────

static double wall_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	return floor((double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6);
}

static double mono_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

// A version-4 UUID into out[37]; false when there is no randomness to read.
static bool random_uuid(char out[37]) {
	uint8_t b[16];
	FILE *f = fopen("/dev/urandom", "rb");
	if (!f || fread(b, 1, 16, f) != 16) { if (f) fclose(f); return false; }
	fclose(f);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
	return true;
}

// A field of /proc/self/status in kB (VmRSS now, VmHWM the peak); -1 if absent.
static long status_kb(const char *field) {
	FILE *f = fopen("/proc/self/status", "r");
	char line[256];
	long kb = -1;
	size_t n = strlen(field);
	if (!f) return -1;
	while (fgets(line, sizeof line, f)) {
		if (strncmp(line, field, n) == 0 && line[n] == ':') { kb = strtol(line + n + 1, NULL, 10); break; }
	}
	fclose(f);
	return kb;
}

#endif
