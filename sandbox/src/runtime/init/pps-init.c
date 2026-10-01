/*
 * The one binary bind-mounted into every sandbox. Two jobs:
 *
 *   (no args)          PID 1. Sandboxes outlive many exec'd processes, and processes that
 *                      outlive their parent reparent here — without something reaping them a
 *                      long session accumulates zombies until it hits the pids cgroup limit.
 *   put/get/mkdir      file transfer, executed *inside* the sandbox. Doing this from the host
 *                      by writing through the merged overlay path would resolve the sandbox's
 *                      symlinks against the host root, which is an escape, not a feature.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t terminating = 0;

static void on_term(int sig) { (void)sig; terminating = 1; }
static void on_child(int sig) { (void)sig; }

static int run_init(void) {
  struct sigaction term, child;
  memset(&term, 0, sizeof term);
  memset(&child, 0, sizeof child);
  term.sa_handler = on_term;
  sigaction(SIGTERM, &term, 0);
  sigaction(SIGINT, &term, 0);
  /* An installed handler is what makes pause() return when a child dies. */
  child.sa_handler = on_child;
  sigaction(SIGCHLD, &child, 0);

  for (;;) {
    while (waitpid(-1, 0, WNOHANG) > 0) {}
    if (terminating) _exit(0);
    pause();
  }
}

static int mkdir_parents(const char *path, mode_t mode) {
  char buf[4096];
  if (strlen(path) >= sizeof buf) { errno = ENAMETOOLONG; return -1; }
  strcpy(buf, path);
  for (char *p = buf + 1; *p; p++) {
    if (*p != '/') continue;
    *p = 0;
    if (mkdir(buf, mode) < 0 && errno != EEXIST) return -1;
    *p = '/';
  }
  return (mkdir(buf, mode) < 0 && errno != EEXIST) ? -1 : 0;
}

static int copy_fd(int in, int out) {
  char buf[1 << 16];
  for (;;) {
    ssize_t n = read(in, buf, sizeof buf);
    if (n == 0) return 0;
    if (n < 0) { if (errno == EINTR) continue; return -1; }
    for (ssize_t off = 0; off < n;) {
      ssize_t w = write(out, buf + off, (size_t)(n - off));
      if (w < 0) { if (errno == EINTR) continue; return -1; }
      off += w;
    }
  }
}

static int dirname_of(const char *path, char *out, size_t cap) {
  const char *slash = strrchr(path, '/');
  if (!slash || slash == path) { out[0] = '/'; out[1] = 0; return 0; }
  size_t len = (size_t)(slash - path);
  if (len >= cap) { errno = ENAMETOOLONG; return -1; }
  memcpy(out, path, len);
  out[len] = 0;
  return 0;
}

static int fail(const char *what, const char *path) {
  fprintf(stderr, "pps-init: %s %s: %s\n", what, path, strerror(errno));
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 2) return run_init();

  if (strcmp(argv[1], "put") == 0 && argc >= 3) {
    mode_t mode = argc >= 4 ? (mode_t)strtol(argv[3], 0, 8) : 0644;
    char parent[4096];
    if (dirname_of(argv[2], parent, sizeof parent) < 0) return fail("put", argv[2]);
    if (mkdir_parents(parent, 0755) < 0) return fail("mkdir", parent);
    /* Symlinks resolve against the sandbox's own root because this runs inside its mount
       namespace; that containment is the safety property, so following them is correct. */
    int fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, mode);
    if (fd < 0) return fail("open", argv[2]);
    if (copy_fd(STDIN_FILENO, fd) < 0) return fail("write", argv[2]);
    if (fchmod(fd, mode) < 0) return fail("chmod", argv[2]);
    return close(fd) < 0 ? fail("close", argv[2]) : 0;
  }

  if (strcmp(argv[1], "get") == 0 && argc >= 3) {
    int fd = open(argv[2], O_RDONLY);
    if (fd < 0) { fprintf(stderr, "pps-init: get %s: %s\n", argv[2], strerror(errno)); return 2; }
    struct stat st;
    if (fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)) {
      fprintf(stderr, "pps-init: get %s: is a directory\n", argv[2]);
      return 2;
    }
    if (copy_fd(fd, STDOUT_FILENO) < 0) return fail("read", argv[2]);
    close(fd);
    return 0;
  }

  if (strcmp(argv[1], "mkdir") == 0 && argc >= 3) {
    return mkdir_parents(argv[2], argc >= 4 ? (mode_t)strtol(argv[3], 0, 8) : 0755) < 0
             ? fail("mkdir", argv[2])
             : 0;
  }

  fprintf(stderr, "pps-init: usage: pps-init [put <path> [mode] | get <path> | mkdir <path> [mode]]\n");
  return 64;
}
