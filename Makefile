HOST ?= 127.0.0.1
PORT ?= 4000

.PHONY: run
run:
	python3 -m http.server $(PORT) --bind $(HOST)
