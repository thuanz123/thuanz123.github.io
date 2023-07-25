
$(document).ready(function() {
    $('.publication-mousecell').mouseover(function() {
        $(this).find('video').css('style.opacity', 1);
        $(this).find('img').css('style.opacity', 0);
    });
    $('.publication-mousecell').mouseout(function() {
        $(this).find('video').css('style.opacity', 0);
        $(this).find('img').css('style.opacity', 1);
    });
})
