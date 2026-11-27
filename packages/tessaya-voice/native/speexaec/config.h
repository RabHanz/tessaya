#pragma once
#define FLOATING_POINT 1
#define USE_SMALLFT 1
#define EXPORT
#define OVERRIDE_SPEEX_WARNING
#define OVERRIDE_SPEEX_WARNING_INT
#define OVERRIDE_SPEEX_NOTIFY
#define OVERRIDE_SPEEX_FATAL
static inline void speex_warning(const char *s) { (void)s; }
static inline void speex_warning_int(const char *s, int v) { (void)s; (void)v; }
static inline void speex_notify(const char *s) { (void)s; }
#define speex_fatal(s) __builtin_trap()
