import { ConfigInterface } from "../config/config";
import * as github from "@actions/github";
import { GithubClient } from "../github/github";

export class UserData {
  config: ConfigInterface;

  constructor(config: ConfigInterface) {
    this.config = config;
  }

  async getUserData(): Promise<string> {
    const ghClient = new GithubClient(this.config);
    const githubActionRunnerVersion = await ghClient.getRunnerVersion();
    const runnerRegistrationToken = await ghClient.getRunnerRegistrationToken();
    if (!this.config.githubActionRunnerLabel)
      throw Error("failed to object job ID for label");

    // This is to handle cleanup of orphaned instances or job cancelations
    var jobStartIdleTimeoutTask = "echo 'No idle timeout set'";
    if (Number(this.config.githubJobStartTtlSeconds) > 0) {
      jobStartIdleTimeoutTask = `
        timeout=${this.config.githubJobStartTtlSeconds};
        found=0;
        (
          while ((timeout-- > 0)); do
            [[ -d "_work" ]] && { found=1; break; };
            sleep 1;
          done;
          [[ $found -eq 0 ]] && ../shutdown_now_script.sh
        ) &
      `;
    }

    // shutdown_now_script.sh => used for forceful terminate
    // shutdown_script.sh => used for graceful termination with a delay allowing for log uploads
    const cmds = [
      "#!/bin/bash -xv",
      `apt update`,
      `apt install -y build-essential gcc`,
      // Create the runner user if it doesn't exist
      `if ! id -u runner >/dev/null 2>&1; then sudo useradd -m runner; fi`,
      `usermod -aG sudo runner`,
      'echo "runner ALL=(ALL) NOPASSWD:$(whereis shutdown)" > /etc/sudoers.d/runner-shutdown',
      `shutdown -P +${this.config.ec2InstanceTtl}`,
      "CURRENT_PATH=/home/runner/",
      'echo "./config.sh remove --token ${runnerRegistrationToken.token} || true" > ${CURRENT_PATH}shutdown_script.sh',
      'echo "sudo shutdown -P +1" > ${CURRENT_PATH}shutdown_script.sh',
      "chmod +x ${CURRENT_PATH}shutdown_script.sh",
      'echo "./config.sh remove --token ${runnerRegistrationToken.token} || true" > ${CURRENT_PATH}shutdown_now_script.sh',
      `echo "shutdown -h now" > $CURRENT_PATH/shutdown_now_script.sh`,
      "chmod +x $CURRENT_PATH/shutdown_now_script.sh",
      "export ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${CURRENT_PATH}shutdown_script.sh",
      "mkdir -p actions-runner && cd actions-runner",
      'echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${CURRENT_PATH}shutdown_script.sh" > .env',
      `GH_RUNNER_VERSION=${githubActionRunnerVersion}`,
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      "curl -O -L https://github.com/actions/runner/releases/download/v${GH_RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${GH_RUNNER_VERSION}.tar.gz",
      "tar xzf ./actions-runner-linux-${RUNNER_ARCH}-${GH_RUNNER_VERSION}.tar.gz",
      `RUNNER_NAME=${this.config.githubJobId}-$(hostname)-ec2`,
      "[ -n \"$(command -v yum)\" ] && yum install libicu -y",
      `chown -R runner.runner $CURRENT_PATH`,
      `su runner`,
      `su -c "./config.sh --unattended --ephemeral --url https://github.com/${github.context.repo.owner}/${github.context.repo.repo} --token ${runnerRegistrationToken.token} --labels ${this.config.githubActionRunnerLabel} --name $RUNNER_NAME ${this.config.githubActionRunnerExtraCliArgs}" runner`,
      jobStartIdleTimeoutTask,
      `su -c "./run.sh" runner`,
    ];

    return Buffer.from(cmds.join("\n")).toString("base64");
  }
}
