#!/bin/bash

read -p 'put name to search : ' rrvar

b="$rrvar"

curl -s "https://3asq.org/?s="${b// /+}"&post_type=wp-manga" | pup 'h3.h4 text{}'

read -p 'put name: ' uservar
a="$uservar"



echo $(curl -s https://3asq.org/manga/"${a// /-}"/  | pup 'li.wp-manga-chapter' | grep -o 'https://3asq.org/manga/.*/' | sed 's/3asq//g' | grep -Eo '[0-9]{1,4}' | head -n 1 )



echo $(curl -s https://3asq.org/manga/"${a// /-}"/  | pup 'li.wp-manga-chapter' | grep -o 'https://3asq.org/manga/.*/' | sed 's/3asq//g' | grep -Eo '[0-9]{1,4}' | tail -n 1 )




read -p "start from: " tr
read -p "stop in:  " n
for i in $(seq $tr $n); do

curl -s https://3asq.org/manga/"${a// /-}"/$i/ | pup 'img.wp-manga-chapter-img'  | grep -i https://3asq.org | sed 's/class="wp-manga-chapter-img">//g' | sed 's/"//g'> "$i".txt

cd ~/storage/downloads/

mkdir -p "${a// /-}"/$i/
mkdir -p "${a// /-}"-manga/

cd

sleep 5

wget -P ~/storage/downloads/"${a// /-}"/$i/ -i "$i".txt

#cd ~/storage/downloads/"${a// /-}"/$i

#find -iname '*.jpg' | convert *.jpg "${a// /-}"-$i.pdf

sleep 5

#mv "${a// /-}"-$i.pdf ~/storage/downloads/"${a// /-}"-manga/

#cd ~/storage/downloads/Manga

#xdg-open $i.pdf

#read -p 'press enter' f
#cd ~/storage/downloads/

#rm -rf "${a// /-}"

cd

rm -rf $i.txt

done