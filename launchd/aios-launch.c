/*
 * aios-launch — a stable "responsible process" for launchd agents.
 *
 * macOS privacy grants (TCC: Full Disk Access, Google Drive / File Provider)
 * are tied to the code identity of the process launchd starts. Homebrew's node
 * is ad-hoc signed, so every `brew upgrade node` yields a new identity and the
 * worker silently loses Drive access (EPERM scandir in obsidian_sync and the
 * backup prune). Launching through this tiny binary moves the grant onto it:
 * children inherit its responsibility, and it never changes unless rebuilt.
 *
 * It spawns argv[1..] (not exec — exec would hand responsibility back to the
 * new image), forwards termination signals, and exits with the child's status.
 *
 *   aios-launch /opt/homebrew/bin/pnpm worker
 */
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <errno.h>

extern char **environ;
static volatile pid_t child = 0;

static void forward(int sig) {
  if (child > 0) kill(child, sig);
}

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: aios-launch <program> [args...]\n");
    return 64;
  }
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = forward;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART;
  int sigs[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2};
  for (size_t i = 0; i < sizeof sigs / sizeof *sigs; i++) sigaction(sigs[i], &sa, NULL);

  pid_t pid;
  int rc = posix_spawnp(&pid, argv[1], NULL, NULL, &argv[1], environ);
  if (rc != 0) {
    fprintf(stderr, "aios-launch: cannot start %s: %s\n", argv[1], strerror(rc));
    return 127;
  }
  child = pid;

  int status;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return 1;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}
