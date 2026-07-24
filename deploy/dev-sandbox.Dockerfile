# Immagine di isolamento per gli agenti SVILUPPATORE di Hive.
#
# Volutamente minima: il codice dell'app (dist + node_modules) viene
# bind-montato a runtime in sola lettura sugli stessi percorsi assoluti
# dell'host, così i symlink dei workspace npm si risolvono senza copiare
# un'immagine da 1 GB. Qui dentro ci mettiamo solo il runtime di sistema
# di cui l'agente ha bisogno per lavorare su un repo.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      ripgrep \
      openssh-client \
      python3 \
      make \
      g++ \
 && rm -rf /var/lib/apt/lists/*

# GIT non deve mai fermarsi a chiedere credenziali in modo interattivo:
# dentro il container non c'è nessuno a rispondere.
ENV GIT_TERMINAL_PROMPT=0

# Nessun ENTRYPOINT fisso: il worker lo lancia con il comando node esplicito
# verso dist/run-in-container.js, passando il job via variabile d'ambiente.
WORKDIR /home/andrea/hive
